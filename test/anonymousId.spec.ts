import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager, cookie, local, session } from "../src/storage";
import { LOCAL_ANONYMOUS_ID_KEY, SESSION_TRAFFIC_SOURCE_KEY } from "../src/constants";
import { generateAnonymousId, clearAnonymousId, __resetAnonymousIdMemory } from "../src/event/utils";

/** Anonymous IDs stay stable across resets and storage failures. */
describe("Anonymous id stability", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let uuidCounter = 0;
  // Restore Node globals exactly after each test.
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

    // Exercise the apex-domain cookie path.
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
      const sent = sandbox.stub((a as any).eventManager.eventQueue, "enqueue");

      // Match an account-effect cleanup.
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

    it("keeps the visit's traffic-source attribution", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      session().set(SESSION_TRAFFIC_SOURCE_KEY, { utm_source: "x", referrer: "dexscreener.com" } as any);

      a.reset();

      expect(session().get(SESSION_TRAFFIC_SOURCE_KEY)).to.deep.equal({
        utm_source: "x",
        referrer: "dexscreener.com",
      });
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
      session().set(SESSION_TRAFFIC_SOURCE_KEY, { utm_source: "x" } as any);

      a.optOutTracking();
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.satisfy(
        (v: any) => v === undefined || v === null || v === ""
      );
      expect(local().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(null);
      expect(session().get(SESSION_TRAFFIC_SOURCE_KEY)).to.equal(null);

      a.optInTracking();
      const after = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);
      expect(after).to.not.equal(before);
      a.cleanup();
    });

    it("cancels an in-flight event without recreating identity after opt-out", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      const enqueue = sandbox.stub((a as any).eventManager.eventQueue, "enqueue");

      // Invalidate work started before a rapid opt-out and opt-in.
      const pending = a.track("started-before-opt-out");
      a.optOutTracking();
      a.optInTracking();
      await pending;

      expect(enqueue.called).to.equal(false);
      expect(cookie().get(LOCAL_ANONYMOUS_ID_KEY)).to.satisfy(
        (v: any) => v === undefined || v === null || v === ""
      );
      expect(local().get(LOCAL_ANONYMOUS_ID_KEY)).to.equal(null);
      a.cleanup();
    });

    it("cancels a delayed page hit across opt-out and opt-in", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      const addEvent = sandbox.stub((a as any).eventManager, "addEvent").resolves();

      await a.page();
      a.optOutTracking();
      a.optInTracking();
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(addEvent.getCalls().filter((call) => call.args[0]?.type === "page")).to.be.empty;
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

      // Simulate a new embedded page load.
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
      // Reject only the apex-domain write.
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
