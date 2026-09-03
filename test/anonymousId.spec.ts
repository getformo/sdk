import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager, cookie, local } from "../src/storage";
import { LOCAL_ANONYMOUS_ID_KEY } from "../src/constants";
import { generateAnonymousId, clearAnonymousId, __resetAnonymousIdMemory } from "../src/event/utils";

/**
 * The anonymous id is the browser id: the Visitors denominator and the key
 * that stitches anonymous activity to a wallet. Two regressions turned one
 * visitor into many:
 *
 * 1. `reset()` used to drop the anonymous id. Apps call `reset()` on every
 *    wallet switch, commonly as a React effect cleanup right before the next
 *    `identify()`, so each switch minted a new visitor. Before 1.28.3 the
 *    drop silently failed on real domains (the cookie lived on the apex
 *    domain and `remove()` only expired the host-only one), which is why the
 *    problem surfaced only on upgrade. `reset()` now keeps the id; only
 *    `optOutTracking()` clears it.
 *
 * 2. When the browser rejects the cookie write (cross-site iframe under
 *    SameSite=Lax, cookies blocked), every event generated a fresh id. The
 *    id now falls back to Web Storage, which is partitioned by the embedding
 *    site but survives reloads, and then to memory for the page lifetime.
 */
describe("Anonymous id stability", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let uuidCounter = 0;
  // Original global descriptors, restored verbatim in afterEach. Deleting
  // is wrong for keys Node itself defines (crypto, navigator, globalThis):
  // it would remove the built-in for every later spec in the process.
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  const GLOBAL_KEYS = [
    "window", "document", "location", "globalThis", "navigator",
    "localStorage", "sessionStorage", "crypto", "history",
  ] as const;

  const ADDRESS_A = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const ADDRESS_B = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";

  const mkWagmi = (sb: sinon.SinonSandbox) => {
    const mockWagmiConfig = {
      subscribe: sb.stub().returns(() => {}),
      state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
      _internal: { store: { subscribe: sb.stub().returns(() => {}) } },
    };
    const mockQueryClient = {
      getMutationCache: () => ({ subscribe: sb.stub().returns(() => {}) }),
      getQueryCache: () => ({ subscribe: sb.stub().returns(() => {}) }),
    };
    return { mockWagmiConfig, mockQueryClient };
  };

  const anonIdsOf = (stub: sinon.SinonStub): string[] =>
    stub.getCalls().map((c) => c.args[0]?.anonymous_id as string);

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    uuidCounter = 0;
    savedGlobals = new Map(
      GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(global, k)])
    );

    // A real two-label host so the apex-domain cookie path is exercised, as
    // on a customer domain. `localhost` would skip the domain attribute.
    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://app.example.com",
    });
    Object.defineProperty(global, "window", { value: jsdom.window, writable: true, configurable: true });
    Object.defineProperty(global, "document", { value: jsdom.window.document, writable: true, configurable: true });
    Object.defineProperty(global, "location", { value: jsdom.window.location, writable: true, configurable: true });
    Object.defineProperty(global, "globalThis", { value: jsdom.window, writable: true, configurable: true });
    Object.defineProperty(global, "navigator", { value: jsdom.window.navigator, writable: true, configurable: true });
    Object.defineProperty(global, "localStorage", { value: jsdom.window.localStorage, writable: true, configurable: true });
    Object.defineProperty(global, "sessionStorage", { value: jsdom.window.sessionStorage, writable: true, configurable: true });
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => `uuid-${++uuidCounter}` },
      writable: true, configurable: true,
    });
    Object.defineProperty(global, "history", { value: jsdom.window.history, writable: true, configurable: true });

    initStorageManager("test-write-key");
    clearAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
  });

  afterEach(() => {
    clearAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
    sandbox.restore();
    savedGlobals.forEach((desc, k) => {
      if (desc) Object.defineProperty(global, k, desc);
      else delete (global as any)[k];
    });
    if (jsdom) jsdom.window.close();
  });

  describe("reset()", () => {
    it("keeps the anonymous id across an identify / reset / identify wallet switch", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      // The enriched event (with anonymous_id) is what reaches the queue.
      const sent = sandbox.stub((a as any).eventManager.eventQueue, "enqueue");

      // The pattern apps use: identify on account change, reset() as the
      // effect cleanup, then identify the next account.
      await a.identify({ address: ADDRESS_A });
      a.reset();
      await a.identify({ address: ADDRESS_B });
      a.reset();
      await a.track("Swap Confirmed");

      const ids = Array.from(new Set(anonIdsOf(sent).filter(Boolean)));
      expect(sent.callCount, "identify, identify, track").to.be.at.least(3);
      expect(ids.length, `anonymous ids seen: ${ids.join(",")}`).to.equal(1);
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(ids[0]);
      a.cleanup();
    });

    it("still forgets the user id and the active wallet", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      sandbox.stub((a as any).eventManager, "addEvent").resolves();
      await a.identify({ address: ADDRESS_A, userId: "user-1" });

      a.reset();

      expect(a.currentUserId).to.equal(undefined);
      expect(a.currentAddress).to.equal(undefined);
      a.cleanup();
    });
  });

  describe("optOutTracking()", () => {
    it("clears the anonymous id so opting back in starts a new one", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      const before = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(before);

      a.optOutTracking();
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.satisfy(
        (v: any) => v === undefined || v === null || v === ""
      );
      expect(local().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(null);

      a.optInTracking();
      const after = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      expect(after).to.not.equal(before);
      a.cleanup();
    });
  });

  describe("when the browser rejects the cookie write", () => {
    it("hands out one id for the page lifetime instead of one per event", () => {
      // Simulate a rejected write: set() is a no-op, get() sees nothing.
      sandbox.stub(cookie(), "set");
      sandbox.stub(cookie(), "get").returns(null);

      const first = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      const second = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      const third = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      expect(second).to.equal(first);
      expect(third).to.equal(first);
    });

    it("persists the held id once a write succeeds", () => {
      const setStub = sandbox.stub(cookie(), "set");
      const getStub = sandbox.stub(cookie(), "get").returns(null);
      const held = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      // Writes start sticking again.
      setStub.restore();
      getStub.restore();
      const persisted = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      expect(persisted).to.equal(held);
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(held);
    });

    it("keeps the id across page loads through Web Storage when cookies are refused", () => {
      sandbox.stub(cookie(), "set");
      sandbox.stub(cookie(), "get").returns(null);

      const first = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      expect(local().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(first);

      // A new page load in the same embedded context: memory is gone,
      // cookies still refused, Web Storage still there.
      __resetAnonymousIdMemory();
      const nextLoad = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      expect(nextLoad).to.equal(first);
    });

    it("drops the Web Storage copy once the cookie is writable again", () => {
      const setStub = sandbox.stub(cookie(), "set");
      const getStub = sandbox.stub(cookie(), "get").returns(null);
      const held = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      expect(local().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(held);
      setStub.restore();
      getStub.restore();

      const persisted = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      expect(persisted).to.equal(held);
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(held);
      expect(local().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(null);
    });

    it("falls back to a host-only cookie when only the domain-scoped write is rejected", () => {
      // The apex-domain write is refused (e.g. a mis-detected public suffix)
      // while a host-only write still sticks. set() must not have thrown the
      // legacy host-only cookie away for nothing.
      const realSet = cookie().set.bind(cookie());
      sandbox.stub(cookie(), "set").callsFake((key, value, options) => {
        if (options?.domain) return;
        realSet(key, value, options);
      });

      const first = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      const second = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      expect(second).to.equal(first);
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(first);
    });

    it("a readable cookie wins over a held id", () => {
      // Hold an id while writes are refused...
      const setStub = sandbox.stub(cookie(), "set");
      const getStub = sandbox.stub(cookie(), "get").returns(null);
      const held = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      setStub.restore();
      getStub.restore();

      // ...then another tab has written the real cookie meanwhile.
      cookie().set(LOCAL_ANONYMOUS_ID_KEY, "id-from-other-tab", { path: "/" });
      const next = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

      expect(next).to.equal("id-from-other-tab");
      expect(next).to.not.equal(held);
    });
  });
});
