import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager, cookie } from "../../src/storage";
import { SESSION_WALLET_DETECTED_KEY } from "../../src/session";

/**
 * `detect` (which wallets are installed) must read the same in every
 * integration mode. Wagmi mode used to skip EIP-6963 discovery outright, so
 * a customer switching to wagmi mode went from thousands of detect events a
 * day to zero, with no code change of their own. Discovery now runs in wagmi
 * mode for detect only; the provider is still not wrapped there, because
 * wagmi owns connect / transaction capture and a wrapped provider would
 * report everything twice.
 */
describe("detect in wagmi mode", () => {
  const ADDR = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const RDNS = "io.metamask";

  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  const GLOBAL_KEYS = [
    "window","globalThis","document","location","navigator","localStorage","sessionStorage",
    "Event","CustomEvent","addEventListener","removeEventListener","dispatchEvent","crypto",
  ] as const;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    savedGlobals = new Map(
      GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(global, k)])
    );
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });
    for (const [k, v] of [
      ["window", jsdom.window],
      ["globalThis", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
      ["Event", jsdom.window.Event],
      ["CustomEvent", jsdom.window.CustomEvent],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    for (const fn of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
      Object.defineProperty(global, fn, {
        value: (jsdom.window as any)[fn].bind(jsdom.window),
        writable: true, configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid" }, writable: true, configurable: true,
    });
    initStorageManager("test-write-key");
    // detect() de-dupes per session on a cookie; start every case clean.
    cookie().remove(SESSION_WALLET_DETECTED_KEY);
  });

  afterEach(() => {
    cookie().remove(SESSION_WALLET_DETECTED_KEY);
    sandbox.restore();
    savedGlobals.forEach((desc, k) => {
      if (desc) Object.defineProperty(global, k, desc);
      else delete (global as any)[k];
    });
    jsdom?.window.close();
  });

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

  /** An injected wallet with an authorized account, never connected in wagmi. */
  const makeInjected = () => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const p: any = {
      isMetaMask: true,
      chainId: "0x1",
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_accounts") return [ADDR];
        return null;
      },
      on: (ev: string, fn: any) => { (handlers[ev] ??= []).push(fn); },
      removeListener: (ev: string, fn: any) => {
        handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn);
      },
      emit: (ev: string, ...a: unknown[]) => (handlers[ev] ?? []).forEach((f) => f(...a)),
    };
    return p;
  };

  const announce = (provider: any) =>
    (global as any).window.dispatchEvent(
      new (global as any).CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({
          info: { uuid: "11111111-2222-4333-8444-555555555555", name: "MetaMask", icon: "data:image/svg+xml;base64,", rdns: RDNS },
          provider,
        }),
      })
    );

  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  async function setup(options: any) {
    const formo = await FormoAnalytics.init("test-write-key", options);
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    return { formo, sent };
  }

  it("emits detect for an announced wallet without wrapping it", async () => {
    const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
    const { formo, sent } = await setup({
      tracking: true,
      wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
    });
    const provider = makeInjected();
    const originalRequest = provider.request;

    announce(provider);
    await settle();

    const detect = sent.find((e) => e.type === "detect");
    expect(detect, "detect event").to.not.equal(undefined);
    expect(detect.rdns).to.equal(RDNS);

    // Not wrapped, not listened to: wagmi owns capture in this mode.
    expect((formo as any).evm.isTracked(provider)).to.equal(false);
    expect(provider.request).to.equal(originalRequest);

    // An authorized-but-not-connected account must not surface as a connect.
    provider.emit("accountsChanged", [ADDR]);
    await settle();
    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);
    formo.cleanup();
  });

  it("detects a wallet once even when re-announced with the session mark gone", async () => {
    const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
    const { formo, sent } = await setup({
      tracking: true,
      wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
    });
    const provider = makeInjected();

    announce(provider);
    await settle();
    // Nothing is tracked in wagmi mode, so "untracked" would be every
    // provider on every announcement. Drop the session de-dup so a
    // regression to that selection shows up as a second detect.
    cookie().remove(SESSION_WALLET_DETECTED_KEY);
    announce(provider);
    await settle();

    expect(sent.filter((e) => e.type === "detect").length).to.equal(1);
    formo.cleanup();
  });

  it("does not identify a never-connected wallet on a no-arg identify()", async () => {
    const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
    const { formo, sent } = await setup({
      tracking: true,
      wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
    });
    announce(makeInjected());
    await settle();

    // The registry now holds a wallet with an authorized account that wagmi
    // never connected. Auto-identify must not pick it up from eth_accounts.
    await formo.identify();
    await settle();

    expect(sent.filter((e) => e.type === "identify")).to.deep.equal([]);
    formo.cleanup();
  });

  it("releases the discovery listener on cleanup", async () => {
    const { mockWagmiConfig, mockQueryClient } = mkWagmi(sandbox);
    const { formo, sent } = await setup({
      tracking: true,
      wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
    });
    formo.cleanup();

    announce(makeInjected());
    await settle();

    expect(sent.filter((e) => e.type === "detect")).to.deep.equal([]);
  });

  it("still wraps announced wallets outside wagmi mode", async () => {
    const { formo } = await setup({ tracking: true });
    const provider = makeInjected();

    announce(provider);
    await settle();

    expect((formo as any).evm.isTracked(provider)).to.equal(true);
    formo.cleanup();
  });
});
