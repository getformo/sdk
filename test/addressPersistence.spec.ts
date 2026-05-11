import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager, cookie } from "../src/storage";
import { CURRENT_WALLET_KEY } from "../src/constants";

/**
 * Regressions for two issues that produced page events with empty `address`:
 *
 * 1. cleanup() didn't tear down the `popstate` / `locationchange` listeners
 *    or restore `history.pushState` / `history.replaceState`. A re-mounted
 *    SDK (React Strict Mode, HMR, options change) left an orphan instance
 *    wired into the DOM that kept emitting page events with no address.
 *
 * 2. `currentAddress` was in-memory only. After a reload, the first page
 *    hit fired before wagmi / EIP-1193 had a chance to reconnect, so it
 *    shipped with no address. We now persist a snapshot on every
 *    connect/identify and seed from it at init.
 */
describe("Address persistence and cleanup", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;

  const ADDRESS = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const OTHER_ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
  const CHAIN_ID = 1;

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

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com",
    });
    Object.defineProperty(global, "window", { value: jsdom.window, writable: true, configurable: true });
    Object.defineProperty(global, "document", { value: jsdom.window.document, writable: true, configurable: true });
    Object.defineProperty(global, "location", { value: jsdom.window.location, writable: true, configurable: true });
    Object.defineProperty(global, "globalThis", { value: jsdom.window, writable: true, configurable: true });
    Object.defineProperty(global, "navigator", { value: jsdom.window.navigator, writable: true, configurable: true });
    Object.defineProperty(global, "localStorage", { value: jsdom.window.localStorage, writable: true, configurable: true });
    Object.defineProperty(global, "sessionStorage", { value: jsdom.window.sessionStorage, writable: true, configurable: true });
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid-1234" },
      writable: true, configurable: true,
    });
    // Make the bare `history` identifier in SDK code resolve to JSDOM's
    // history, so trackPageHits actually wraps the real pushState/replaceState.
    Object.defineProperty(global, "history", { value: jsdom.window.history, writable: true, configurable: true });

    initStorageManager("test-write-key");
    cookie().remove(CURRENT_WALLET_KEY);
  });

  afterEach(() => {
    cookie().remove(CURRENT_WALLET_KEY);
    sandbox.restore();
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).location;
    delete (global as any).globalThis;
    delete (global as any).navigator;
    delete (global as any).localStorage;
    delete (global as any).sessionStorage;
    delete (global as any).crypto;
    delete (global as any).history;
    if (jsdom) jsdom.window.close();
  });

  describe("persists currentAddress across page reloads", () => {
    it("connect() writes the snapshot cookie and a fresh init seeds from it", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      sandbox.stub(a as any, "trackEvent").resolves();
      await a.connect({ chainId: CHAIN_ID, address: ADDRESS });

      expect(cookie().get(CURRENT_WALLET_KEY)).to.be.a("string");
      a.cleanup();

      // Simulate a reload by creating a fresh instance.
      const { mockWagmiConfig: c2, mockQueryClient: q2 } = mkWagmi(sandbox);
      const b = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: c2 as any, queryClient: q2 as any },
      });

      expect(b.currentAddress).to.equal(ADDRESS);
      expect(b.currentChainId).to.equal(CHAIN_ID);
      b.cleanup();
    });

    it("track() after a reload carries the persisted address", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      sandbox.stub(a as any, "trackEvent").resolves();
      await a.connect({ chainId: CHAIN_ID, address: ADDRESS });
      a.cleanup();

      const { mockWagmiConfig: c2, mockQueryClient: q2 } = mkWagmi(sandbox);
      const b = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: c2 as any, queryClient: q2 as any },
      });
      const addEventStub = sandbox.stub((b as any).eventManager, "addEvent").resolves();

      await b.track("Deposit Success", { value_usd: 508 });

      expect(addEventStub.calledOnce).to.be.true;
      const [, addressArg] = addEventStub.firstCall.args;
      expect(addressArg).to.equal(ADDRESS);
      b.cleanup();
    });

    it("disconnect() clears the persisted snapshot", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      sandbox.stub(a as any, "trackEvent").resolves();
      await a.connect({ chainId: CHAIN_ID, address: ADDRESS });
      expect(cookie().get(CURRENT_WALLET_KEY)).to.be.a("string");

      await a.disconnect({ chainId: CHAIN_ID, address: ADDRESS });
      expect(cookie().get(CURRENT_WALLET_KEY)).to.satisfy(
        (v: any) => v === undefined || v === null || v === ""
      );
      a.cleanup();
    });

    it("reset() clears the persisted snapshot", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      sandbox.stub(a as any, "trackEvent").resolves();
      await a.connect({ chainId: CHAIN_ID, address: ADDRESS });

      a.reset();
      expect(cookie().get(CURRENT_WALLET_KEY)).to.satisfy(
        (v: any) => v === undefined || v === null || v === ""
      );
      a.cleanup();
    });
  });

  describe("cleanup() detaches page-hit hooks", () => {
    it("after cleanup the orphan instance stops handling pushState", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      const orphanOnLocationChange = sandbox.spy(a as any, "onLocationChange");
      a.cleanup();

      // Trigger a pushState — orphan must not handle it.
      jsdom.window.history.pushState({}, "", "/orphan-target");
      // Allow the synthetic event (if any) to dispatch.
      await new Promise((r) => setTimeout(r, 0));

      expect(orphanOnLocationChange.called).to.be.false;
    });

    it("a fresh instance after cleanup still receives pushState events", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      a.cleanup();

      const { mockWagmiConfig: c2, mockQueryClient: q2 } = mkWagmi(sandbox);
      const b = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: c2 as any, queryClient: q2 as any },
      });
      const liveOnLocationChange = sandbox.spy(b as any, "onLocationChange");

      jsdom.window.history.pushState({}, "", "/live-target");
      await new Promise((r) => setTimeout(r, 0));

      expect(liveOnLocationChange.called).to.be.true;
      b.cleanup();
    });

    it("only the live instance emits a page event after a remount", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      const orphanAdd = sandbox.stub((a as any).eventManager, "addEvent").resolves();
      a.cleanup();

      const { mockWagmiConfig: c2, mockQueryClient: q2 } = mkWagmi(sandbox);
      const b = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: c2 as any, queryClient: q2 as any },
      });
      const liveAdd = sandbox.stub((b as any).eventManager, "addEvent").resolves();

      orphanAdd.resetHistory();
      liveAdd.resetHistory();

      jsdom.window.history.pushState({}, "", "/new-path");
      // trackPageHit uses setTimeout(300); wait it out.
      await new Promise((r) => setTimeout(r, 350));

      // The orphan instance must not enqueue a page event anymore.
      const orphanPageCalls = orphanAdd
        .getCalls()
        .filter((c: sinon.SinonSpyCall) => (c.args[0] as any)?.type === "page");
      expect(orphanPageCalls.length).to.equal(0);

      // The live instance still emits.
      const livePageCalls = liveAdd
        .getCalls()
        .filter((c: sinon.SinonSpyCall) => (c.args[0] as any)?.type === "page");
      expect(livePageCalls.length).to.be.greaterThan(0);
      b.cleanup();
    });

    it("ignores a corrupt persisted snapshot and clears the cookie", async () => {
      cookie().set(CURRENT_WALLET_KEY, "not-json{");
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      expect(a.currentAddress).to.be.undefined;
      expect(cookie().get(CURRENT_WALLET_KEY)).to.satisfy(
        (v: any) => v === undefined || v === null || v === ""
      );
      a.cleanup();
    });

    it("does not seed from a persisted invalid address", async () => {
      cookie().set(
        CURRENT_WALLET_KEY,
        JSON.stringify({ address: "0xnot-an-address", chainId: CHAIN_ID })
      );
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      expect(a.currentAddress).to.be.undefined;
      a.cleanup();
    });

    it("a later connect() to a different address overwrites the persisted snapshot", async () => {
      const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
      const a = await FormoAnalytics.init("test-write-key", {
        wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
      });
      sandbox.stub(a as any, "trackEvent").resolves();
      await a.connect({ chainId: CHAIN_ID, address: ADDRESS });
      await a.connect({ chainId: CHAIN_ID, address: OTHER_ADDRESS });

      const raw = cookie().get(CURRENT_WALLET_KEY) as string;
      const parsed = JSON.parse(raw);
      expect(parsed.address).to.equal(OTHER_ADDRESS);
      a.cleanup();
    });
  });
});
