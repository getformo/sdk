import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: `optInTracking()` only cleared the consent flag.
 *
 * A wallet already connected while the visitor was opted out is declined by
 * `syncWalletState()`, and an unchanged wagmi connection produces no status or
 * chain update to retry on. Opting back in therefore left that wallet - and
 * every signature and transaction it went on to make - invisible for the rest
 * of the page load.
 */
describe("Adoption after opting back into tracking", () => {
  const ADDRESS = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com",
    });
    for (const [k, v] of [
      ["window", jsdom.window],
      // Other specs in this suite set and then delete `globalThis`, so it can
      // be missing by the time this one runs. Set it explicitly.
      ["globalThis", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    // Node has its own Event/CustomEvent in a different realm, and jsdom
    // rejects those. mipd's EIP-6963 discovery dispatches one, so the
    // constructors have to come from the jsdom window.
    for (const ctor of ["Event", "CustomEvent"] as const) {
      Object.defineProperty(global, ctor, {
        value: (jsdom.window as any)[ctor], writable: true, configurable: true,
      });
    }
    // mipd's EIP-6963 store subscribes on globalThis, which under mocha is
    // Node's global rather than jsdom's window.
    for (const fn of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
      Object.defineProperty(global, fn, {
        value: (jsdom.window as any)[fn].bind(jsdom.window),
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid-1234" },
      writable: true,
      configurable: true,
    });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    sandbox.restore();
    for (const k of ["window", "document", "location", "navigator", "globalThis", "localStorage", "sessionStorage", "crypto", "Event", "CustomEvent", "addEventListener", "removeEventListener", "dispatchEvent"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  /** A wagmi config stub holding one live connection. */
  const connectedConfig = (address: string, chainId = 1) => {
    const connections = new Map();
    connections.set("c1", {
      accounts: [address],
      chainId,
      connector: { id: "mock", name: "Mock", type: "injected", uid: "c1" },
    });
    return {
      subscribe: sandbox.stub().returns(() => {}),
      state: { status: "connected", connections, current: "c1", chainId },
      _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
    } as any;
  };

  const queryClientStub = () =>
    ({
      getMutationCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
      getQueryCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
    }) as any;

  it("adopts the live wallet when opt-in lifts suppression", async () => {
    // The real production shape: a wallet already connected while the visitor
    // is opted out. `syncWalletState()` declines it, and an unchanged wagmi
    // connection produces no status or chain update to retry on, so without
    // the opt-in retry that wallet stays invisible for the whole page load.
    //
    // Deliberately driven through a CONNECTED wagmi state rather than by
    // injecting `trackingState` by hand: an injected address is restored by
    // the central-state resync alone, so the seed could be removed entirely
    // and such a test would still pass.
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      wagmi: { config: connectedConfig(ADDRESS), queryClient: queryClientStub() },
    });
    formo.optOutTracking();

    // Rebuild while suppressed, so the handler is constructed against a live
    // connection it must decline.
    formo.cleanup?.();
    const suppressed = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      wagmi: { config: connectedConfig(ADDRESS), queryClient: queryClientStub() },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(suppressed.currentAddress, "declined while opted out").to.be.undefined;

    suppressed.optInTracking();
    await new Promise((r) => setTimeout(r, 20));

    expect(suppressed.currentAddress, "the LIVE wallet is adopted").to.equal(ADDRESS);
    expect(suppressed.currentChainId, "and its chain").to.equal(1);
    suppressed.cleanup?.();
  });

  it("does not resurrect a cached wallet that is no longer connected", async () => {
    // Opting out and disconnecting, then opting back in, must not restore the
    // wallet the user has left - later activity would be attributed to it.
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      wagmi: {
        config: {
          subscribe: sandbox.stub().returns(() => {}),
          state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
          _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
        } as any,
        queryClient: queryClientStub(),
      },
    });
    const handler = (formo as any).wagmiHandler;
    // A wallet the handler still remembers, while wagmi has none.
    handler.trackingState.lastAddress = ADDRESS;
    handler.trackingState.lastChainId = 1;

    formo.optOutTracking();
    formo.optInTracking();
    await new Promise((r) => setTimeout(r, 20));

    expect(formo.currentAddress, "no resurrection").to.be.undefined;
    expect(
      handler.trackingState.lastAddress,
      "and the stale wallet is released"
    ).to.be.undefined;
    formo.cleanup?.();
  });

  it("reports whether an event would currently be sent", async () => {
    // The predicate integrations use to avoid marking a wallet as reported
    // when the tracking gate is going to drop its event.
    // `tracking: false` first, while no opt-out flag exists. Asserting this
    // after an opt-out would only re-measure the consent flag, since
    // shouldTrack() short-circuits on it before reading the option.
    const off = await FormoAnalytics.init("test-write-key", { tracking: false });
    expect(off.willTrackEvent(), "tracking disabled").to.be.false;
    off.cleanup?.();

    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    expect(formo.willTrackEvent(), "tracking on").to.be.true;
    formo.optOutTracking();
    expect(formo.willTrackEvent(), "opted out").to.be.false;
    formo.optInTracking();
    expect(formo.willTrackEvent(), "opted back in").to.be.true;
    formo.cleanup?.();
  });

  it("asks the wagmi handler to adopt when a SPA navigates", async () => {
    // Host/path exclusions are evaluated per navigation, so leaving an
    // excluded route makes a wallet trackable with no wagmi event firing.
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      wagmi: {
        config: {
          subscribe: sandbox.stub().returns(() => {}),
          state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
          _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
        } as any,
        queryClient: {
          getMutationCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
          getQueryCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
        } as any,
      },
    });

    const handler = (formo as any).wagmiHandler;
    const retry = sandbox.stub(handler, "retryAdoption");
    sandbox.stub(formo as any, "trackPageHit");

    // Same URL: nothing to do.
    await (formo as any).onLocationChange();
    expect(retry.called, "no navigation, no retry").to.be.false;

    jsdom.reconfigure({ url: "https://example.com/allowed" });
    await (formo as any).onLocationChange();

    expect(retry.calledOnce, "adoption retried on navigation").to.be.true;
    formo.cleanup?.();
  });
});
