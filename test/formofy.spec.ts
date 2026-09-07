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
