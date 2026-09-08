import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { formofy, _resetFormofy } from "../src/initialization";

// One live instance per page. Tag managers, React strict mode, and hot
// reloads all call formofy() more than once; a second instance doubles
// every autocaptured event.
describe("formofy", () => {
  let init: sinon.SinonStub;
  type Fake = FormoAnalytics & { cleanup: sinon.SinonSpy; disposed: boolean };
  const instance = (writeKey: string): Fake => {
    const f = { writeKey, disposed: false } as unknown as Fake;
    f.cleanup = sinon.spy(() => { f.disposed = true; });
    return f;
  };
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://example.com" });
    Object.defineProperty(global, "window", { value: dom.window, writable: true, configurable: true });
    _resetFormofy();
    init = sinon.stub(FormoAnalytics, "init");
  });
  afterEach(() => {
    init.restore();
    dom.window.close();
    delete (global as { window?: unknown }).window;
  });

  it("reuses the instance when called again with the same write key", async () => {
    const a = instance("wk_1");
    init.resolves(a);
    const ready1 = sinon.spy();
    const ready2 = sinon.spy();

    formofy("wk_1", { ready: ready1 });
    await tick();
    formofy("wk_1", { ready: ready2 });
    await tick();

    expect(init.calledOnce).to.be.true;
    expect(window.formo).to.equal(a);
    expect(ready1.calledOnceWith(a)).to.be.true;
    expect(ready2.calledOnceWith(a)).to.be.true;
    expect(a.cleanup.called).to.be.false;
  });

  it("shares one initialisation when the second call lands before the first resolves", async () => {
    const a = instance("wk_1");
    let resolve!: (f: FormoAnalytics) => void;
    init.returns(new Promise<FormoAnalytics>((r) => { resolve = r; }));
    const ready2 = sinon.spy();

    formofy("wk_1");
    formofy("wk_1", { ready: ready2 });
    resolve(a);
    await tick();

    expect(init.calledOnce).to.be.true;
    expect(window.formo).to.equal(a);
    expect(ready2.calledOnceWith(a)).to.be.true;
  });

  it("tears the previous instance down when the write key changes", async () => {
    const a = instance("wk_1");
    const b = instance("wk_2");
    init.onFirstCall().resolves(a).onSecondCall().resolves(b);

    formofy("wk_1");
    await tick();
    formofy("wk_2");
    await tick();
    await tick();

    expect(init.calledTwice).to.be.true;
    expect(a.cleanup.calledOnce, "old instance closed").to.be.true;
    expect(init.secondCall.calledAfter(a.cleanup.firstCall), "closed before the new init").to.be.true;
    expect(window.formo).to.equal(b);
  });

  it("tries again after a failed initialisation", async () => {
    const a = instance("wk_1");
    init.onFirstCall().rejects(new Error("boom")).onSecondCall().resolves(a);
    const error = sinon.stub(console, "error");
    try {
      formofy("wk_1");
      await tick();
      await tick();
      formofy("wk_1");
      await tick();
      await tick();
    } finally {
      error.restore();
    }

    expect(init.calledTwice).to.be.true;
    expect(window.formo).to.equal(a);
  });

  it("adopts an instance the app already put on window.formo", async () => {
    const own = instance("wk_1");
    (window as { formo?: unknown }).formo = own;
    const ready = sinon.spy();

    formofy("wk_1", { ready });
    await tick();

    expect(init.called, "no second instance for the same key").to.be.false;
    expect(ready.calledOnceWith(own)).to.be.true;
    expect(own.cleanup.called).to.be.false;
  });

  it("replaces an adopted instance when the write key differs", async () => {
    const own = instance("wk_1");
    (window as { formo?: unknown }).formo = own;
    const b = instance("wk_2");
    init.resolves(b);

    formofy("wk_2");
    await tick();
    await tick();

    expect(own.cleanup.calledOnce).to.be.true;
    expect(init.calledOnceWith("wk_2")).to.be.true;
    expect(window.formo).to.equal(b);
  });

  it("starts over when the app tore the cached instance down itself", async () => {
    const a = instance("wk_1");
    const b = instance("wk_1");
    init.onFirstCall().resolves(a).onSecondCall().resolves(b);

    formofy("wk_1");
    await tick();
    a.cleanup(); // the app's own teardown, outside formofy
    formofy("wk_1");
    await tick();
    await tick();

    expect(init.calledTwice).to.be.true;
    expect(window.formo).to.equal(b);
  });

  it("does not hand a disposed instance back after a failed key switch", async () => {
    const a = instance("wk_1");
    const a2 = instance("wk_1");
    init.onFirstCall().resolves(a).onSecondCall().rejects(new Error("boom")).onThirdCall().resolves(a2);
    const error = sinon.stub(console, "error");
    try {
      formofy("wk_1");
      await tick();
      formofy("wk_2"); // tears a down, then fails
      await tick(); await tick(); await tick();
      expect(window.formo, "disposed instance is not left as the global").to.equal(undefined);
      formofy("wk_1");
      await tick(); await tick();
    } finally {
      error.restore();
    }

    expect(init.callCount).to.equal(3);
    expect(window.formo).to.equal(a2);
  });

  it("keeps an adopted instance even after the app removes the global", async () => {
    const own = instance("wk_1");
    (window as { formo?: unknown }).formo = own;

    formofy("wk_1");
    await tick();
    delete (window as { formo?: unknown }).formo;
    formofy("wk_1");
    await tick();

    expect(init.called, "the adoption is remembered").to.be.false;
    expect(own.cleanup.called).to.be.false;
  });

  it("replaces a disposed instance found on window.formo and drops the dead global", async () => {
    const dead = instance("wk_1");
    dead.cleanup();
    (window as { formo?: unknown }).formo = dead;
    const fresh = instance("wk_1");
    init.resolves(fresh);

    formofy("wk_1");
    await tick();
    await tick();

    expect(init.calledOnceWith("wk_1")).to.be.true;
    expect(window.formo).to.equal(fresh);
  });

  it("shares one pending instance between two copies of the bundle", async () => {
    // A tag manager that injects the script twice evaluates the module twice.
    const a = instance("wk_1");
    let resolve!: (f: FormoAnalytics) => void;
    init.returns(new Promise<FormoAnalytics>((r) => { resolve = r; }));
    const modulePath = require.resolve("../src/initialization");
    delete require.cache[modulePath];
    const copy2 = require(modulePath) as { formofy: typeof formofy };
    const ready2 = sinon.spy();

    formofy("wk_1");        // first copy, init still pending
    copy2.formofy("wk_1", { ready: ready2 }); // second copy, same page
    resolve(a);
    await tick();

    expect(init.calledOnce, "one instance across both copies").to.be.true;
    expect(ready2.calledOnceWith(a)).to.be.true;
    expect(window.formo).to.equal(a);
  });

  it("lets a newer call win over a stale same-key restart", async () => {
    const a = instance("wk_1");
    const b = instance("wk_2");
    init.onFirstCall().resolves(a).onSecondCall().resolves(b);

    formofy("wk_1");
    await tick();
    a.cleanup();          // the app's own teardown
    formofy("wk_1");      // would restart wk_1 once the promise settles
    formofy("wk_2");      // but this call lands first
    await tick(); await tick(); await tick();

    expect(init.calledTwice, "no third init for the stale wk_1 restart").to.be.true;
    expect(init.secondCall.args[0]).to.equal("wk_2");
    expect(window.formo).to.equal(b);
  });

  it("initialises synchronously when nothing is live yet", () => {
    init.resolves(instance("wk_1"));

    formofy("wk_1");

    // The constructor installs the history hooks; a navigation right after
    // formofy() must already be seen.
    expect(init.calledOnce).to.be.true;
  });

  it("adopts an instance the app swapped onto window.formo after formofy cached one", async () => {
    const a = instance("wk_1");
    init.resolves(a);
    formofy("wk_1");
    await tick();
    const own = instance("wk_2");
    (window as { formo?: unknown }).formo = own;
    init.resetHistory();
    const ready = sinon.spy();

    formofy("wk_2", { ready });
    await tick();

    expect(init.called, "no extra instance for the app's own key").to.be.false;
    expect(a.cleanup.calledOnce, "the cached instance is retired").to.be.true;
    expect(window.formo).to.equal(own);
    expect(ready.calledOnceWith(own)).to.be.true;
  });

  it("adopts an instance the app installs while the cached init is still pending", async () => {
    const a = instance("wk_1");
    let resolve!: (f: FormoAnalytics) => void;
    init.returns(new Promise<FormoAnalytics>((r) => { resolve = r; }));
    formofy("wk_1"); // pending
    const own = instance("wk_2");
    (window as { formo?: unknown }).formo = own;
    init.resetHistory();
    const ready = sinon.spy();

    formofy("wk_2", { ready });
    await tick();
    resolve(a); // the superseded init completes late
    await tick();

    expect(init.called, "no extra instance for the app's own key").to.be.false;
    expect(ready.calledOnceWith(own)).to.be.true;
    expect(a.cleanup.calledOnce, "the late result retires itself").to.be.true;
    expect(window.formo).to.equal(own);
  });

  it("switches key once when two calls for the new key land back-to-back", async () => {
    const a = instance("wk_1");
    const b = instance("wk_2");
    init.onFirstCall().resolves(a).onSecondCall().resolves(b);
    formofy("wk_1");
    await tick();

    formofy("wk_2");
    formofy("wk_2");
    await tick(); await tick();

    expect(init.calledTwice, "one init for wk_2").to.be.true;
    expect(a.cleanup.calledOnce).to.be.true;
    expect(window.formo).to.equal(b);
  });

  it("retires a resolved predecessor and starts the new key synchronously", async () => {
    const a = instance("wk_1");
    init.onFirstCall().resolves(a).onSecondCall().resolves(instance("wk_2"));
    formofy("wk_1");
    await tick();

    formofy("wk_2");

    // Before any microtask: A is gone and B's constructor has run, so a
    // navigation right after the call belongs to B.
    expect(a.cleanup.calledOnce).to.be.true;
    expect(init.calledTwice).to.be.true;
  });

  it("runs every ready callback across a shared same-key restart", async () => {
    const a = instance("wk_1");
    const fresh = instance("wk_1");
    init.onFirstCall().resolves(a).onSecondCall().resolves(fresh);
    formofy("wk_1");
    await tick();
    a.cleanup();
    const ready1 = sinon.spy();
    const ready2 = sinon.spy();

    formofy("wk_1", { ready: ready1 });
    formofy("wk_1", { ready: ready2 });
    await tick(); await tick(); await tick();

    expect(init.calledTwice, "one restart shared by both calls").to.be.true;
    expect(ready1.calledOnceWith(fresh)).to.be.true;
    expect(ready2.calledOnceWith(fresh)).to.be.true;
  });

  it("puts the retained instance back on window.formo if the app removed it", async () => {
    const a = instance("wk_1");
    init.resolves(a);
    formofy("wk_1");
    await tick();
    delete (window as { formo?: unknown }).formo;
    const ready = sinon.spy();

    formofy("wk_1", { ready });
    await tick();

    expect(window.formo).to.equal(a);
    expect(ready.calledOnceWith(a)).to.be.true;
  });

  it("keeps a live entry written by an older copy of the bundle", async () => {
    // A previous version stored the entry bare in the page slot.
    const old = instance("wk_1");
    (window as unknown as Record<symbol, unknown>)[Symbol.for("formo.live")] = {
      writeKey: "wk_1", promise: Promise.resolve(old), instance: old,
    };
    const ready = sinon.spy();

    formofy("wk_1", { ready });
    await tick();

    expect(init.called, "no second instance").to.be.false;
    expect(ready.calledOnceWith(old)).to.be.true;
  });

  it("skips a queued key that was superseded while it waited", async () => {
    const a = instance("wk_1");
    const c = instance("wk_3");
    let resolveA!: (f: FormoAnalytics) => void;
    init.onFirstCall().returns(new Promise<FormoAnalytics>((r) => { resolveA = r; }));
    init.onSecondCall().resolves(c);
    formofy("wk_1"); // pending
    formofy("wk_2"); // queued behind A
    formofy("wk_3"); // takes the slot from B
    resolveA(a);
    await tick(); await tick(); await tick();

    expect(init.calledTwice, "B never initialised").to.be.true;
    expect(init.secondCall.args[0]).to.equal("wk_3");
    expect(a.cleanup.calledOnce).to.be.true;
    expect(window.formo).to.equal(c);
  });

  it("runs ready for a healthy instance even when a key switch follows in the same tick", async () => {
    const a = instance("wk_1");
    init.onFirstCall().resolves(a).onSecondCall().resolves(instance("wk_2"));
    formofy("wk_1");
    await tick();
    const ready = sinon.spy();

    formofy("wk_1", { ready });
    formofy("wk_2");
    await tick();

    expect(ready.calledOnceWith(a)).to.be.true;
  });

  it("stands down a pending result when the app installed its own instance meanwhile", async () => {
    const a = instance("wk_1");
    let resolve!: (f: FormoAnalytics) => void;
    init.returns(new Promise<FormoAnalytics>((r) => { resolve = r; }));
    const ready = sinon.spy();
    formofy("wk_1", { ready }); // pending, nothing else calls formofy
    const own = instance("wk_1");
    (window as { formo?: unknown }).formo = own;

    resolve(a);
    await tick();

    expect(a.cleanup.calledOnce, "the late result retires itself").to.be.true;
    expect(window.formo).to.equal(own);
    expect(ready.calledOnceWith(own), "same key: ready runs on the app's instance").to.be.true;
  });

  it("does not hand a retired restart to a queued ready callback", async () => {
    const a = instance("wk_1");
    const fresh = instance("wk_1");
    const c = instance("wk_2");
    let resolveFresh!: (f: FormoAnalytics) => void;
    init.onFirstCall().resolves(a);
    init.onSecondCall().returns(new Promise<FormoAnalytics>((r) => { resolveFresh = r; }));
    init.onThirdCall().resolves(c);
    formofy("wk_1");
    await tick();
    a.cleanup();
    const ready2 = sinon.spy();
    formofy("wk_1");                 // starts the shared restart
    formofy("wk_1", { ready: ready2 }); // queues on it
    await tick();
    formofy("wk_2");                 // supersedes the restart
    resolveFresh(fresh);
    await tick(); await tick(); await tick();

    expect(fresh.cleanup.calledOnce, "the restart result retired").to.be.true;
    expect(ready2.called, "no callback with a retired instance").to.be.false;
    expect(window.formo).to.equal(c);
  });

  it("does not start a queued key when the app installed its own instance meanwhile", async () => {
    const a = instance("wk_1");
    let resolveA!: (f: FormoAnalytics) => void;
    init.onFirstCall().returns(new Promise<FormoAnalytics>((r) => { resolveA = r; }));
    formofy("wk_1"); // pending
    const ready = sinon.spy();
    formofy("wk_2", { ready }); // queued behind A
    const own = instance("wk_2");
    (window as { formo?: unknown }).formo = own;
    resolveA(a);
    await tick(); await tick(); await tick();

    expect(init.calledOnce, "wk_2 never initialised: the app's instance is adopted").to.be.true;
    expect(a.cleanup.calledOnce).to.be.true;
    expect(window.formo).to.equal(own);
    expect(ready.calledOnceWith(own)).to.be.true;
  });

  it("recovers when a pending entry migrated from an older copy rejects", async () => {
    let reject!: (e: Error) => void;
    (window as unknown as Record<symbol, unknown>)[Symbol.for("formo.live")] = {
      writeKey: "wk_1", promise: new Promise<FormoAnalytics>((_, r) => { reject = r; }),
    };
    const fresh = instance("wk_1");
    init.resolves(fresh);

    formofy("wk_1"); // migrates the slot and waits on the old pending init
    reject(new Error("old init failed"));
    await tick(); await tick();
    formofy("wk_1"); // must start over, not reuse the rejected entry
    await tick();

    expect(init.calledOnce).to.be.true;
    expect(window.formo).to.equal(fresh);
  });

  it("does not let a throwing ready callback break the second caller", async () => {
    const a = instance("wk_1");
    init.resolves(a);
    const error = sinon.stub(console, "error");
    const ready2 = sinon.spy();
    try {
      formofy("wk_1", { ready: () => { throw new Error("app bug"); } });
      await tick();
      formofy("wk_1", { ready: ready2 });
      await tick();
    } finally {
      error.restore();
    }

    expect(ready2.calledOnceWith(a)).to.be.true;
    expect(error.calledOnce).to.be.true;
  });
});
