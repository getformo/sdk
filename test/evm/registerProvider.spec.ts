import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";

/**
 * registerProvider (P-2403).
 *
 * Discovery only sees EIP-6963 announcements and `window.ethereum`, which is
 * every injected wallet and nothing else. WalletConnect and Ledger providers
 * are constructed by the app and announce nothing, so their sessions were
 * invisible: production showed ONE WalletConnect detect event in 30 days
 * against 81k for MetaMask. `registerProvider` is the missing entry point:
 * the same pipeline a discovered provider takes, for a provider the page
 * hands over itself.
 */
describe("registerProvider", () => {
  const ADDR = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const PEER = "Ledger Live";

  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
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
  });

  afterEach(() => {
    sandbox.restore();
    for (const k of ["window","document","location","navigator","localStorage","sessionStorage","crypto"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  /**
   * A WalletConnect-shaped provider: constructed, never announced, never at
   * window.ethereum. Synchronous `accounts`/`chainId` state and a session
   * with peer metadata, exactly as @walletconnect/ethereum-provider exposes.
   */
  const makeWcProvider = (opts: { accounts?: string[]; peer?: string } = {}) => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const p: any = {
      accounts: opts.accounts ?? [],
      chainId: "0x1",
      session:
        opts.peer !== undefined
          ? { peer: { metadata: { name: opts.peer, url: "https://ledger.com" } } }
          : undefined,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_accounts") return p.accounts;
        if (method === "personal_sign") return "0xsigned";
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

  async function setup(options: any = { tracking: true }) {
    const formo = await FormoAnalytics.init("test-write-key", options);
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    return { formo, sent };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("captures nothing from a constructed provider that is never registered", async () => {
    // Today's failure, pinned: this is the P-2403 gap itself.
    const provider = makeWcProvider({ accounts: [ADDR] });
    const { formo, sent } = await setup();

    provider.emit("accountsChanged", [ADDR]);
    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(sent.filter((e) => e.type !== "page")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("tracks a registered provider end to end: detect, connect, signature", async () => {
    const provider = makeWcProvider({ peer: PEER });
    const { formo, sent } = await setup();

    expect(formo.registerProvider(provider)).to.equal(true);
    provider.accounts = [ADDR];
    provider.emit("accountsChanged", [ADDR]);
    await provider.request({ method: "personal_sign", params: ["0x68656c6c6f", ADDR] });
    await settle();

    const types = sent.map((e) => e.type);
    expect(types).to.include("detect");
    expect(types).to.include("connect");
    expect(sent.filter((e) => e.type === "signature").length, "requested + confirmed").to.equal(2);
    formo.cleanup?.();
  });

  it("adopts a session that already exists at registration, with no RPC", async () => {
    // WalletConnect apps typically connect BEFORE any analytics call runs.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const requestSpy = sandbox.spy(provider, "request");
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    expect(sent.some((e) => e.type === "connect" && e.address === ADDR)).to.equal(true);
    // Nothing analytics-only may go on the wallet transport, least of all
    // WalletConnect's serialised relay socket.
    expect(requestSpy.called).to.equal(false);
    formo.cleanup?.();
  });

  it("names the real wallet behind the transport from peer metadata", async () => {
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    // At the addEvent stage detect carries its identity at the top level;
    // the wire serializer nests and snake_cases it later.
    const detect = sent.find((e) => e.type === "detect");
    expect(detect?.providerName).to.equal(PEER);
    expect(detect?.rdns).to.equal("com.walletconnect");
    formo.cleanup?.();
  });

  it("lets caller info override everything", async () => {
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();

    formo.registerProvider(provider, { name: "My Kiosk Wallet", rdns: "com.example.kiosk" });
    await settle();

    const detect = sent.find((e) => e.type === "detect");
    expect(detect?.providerName).to.equal("My Kiosk Wallet");
    expect(detect?.rdns).to.equal("com.example.kiosk");
    formo.cleanup?.();
  });

  it("falls back to flag sniffing when there is no session peer", async () => {
    const provider = makeWcProvider({ accounts: [ADDR] });
    provider.isWalletConnect = true;
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    const detect = sent.find((e) => e.type === "detect");
    expect(detect?.providerName).to.equal("WalletConnect");
    formo.cleanup?.();
  });

  it("is idempotent: registering twice tracks once", async () => {
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    formo.registerProvider(provider);
    await settle();

    expect(sent.filter((e) => e.type === "connect").length).to.equal(1);
    formo.cleanup?.();
  });

  it("refuses in wagmi mode, where the connector system already tracks the session", async () => {
    const wagmiConfig: any = {
      subscribe: () => () => undefined,
      getState: () => ({ status: "disconnected", connections: new Map(), current: undefined, chainId: undefined }),
      state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
    };
    const { formo, sent } = await setup({ tracking: true, wagmi: { config: wagmiConfig } });

    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(false);
    await settle();

    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("refuses an object that is not an EIP-1193 provider", async () => {
    const { formo } = await setup();
    expect(formo.registerProvider({} as any)).to.equal(false);
    formo.cleanup?.();
  });
});
