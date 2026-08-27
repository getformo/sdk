import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";
import { __resetSeededWallet } from "../../src/wagmi/WagmiEventHandler";

/**
 * Hybrid capture: wagmi mode + the request wrapper.
 *
 * Wagmi mode watches the store and caches, which see HOOK-driven calls
 * only. Imperative viem calls (walletClient.sendTransaction, .signMessage,
 * .writeContract, raw request) create no mutation and were silently lost -
 * KyberSwap's cross-chain adapters and login signatures, audited live. The
 * connector's provider now gets the same request wrapper the 1193 path
 * uses, and a pending-mutation check keeps the two capture layers from
 * double-reporting: TanStack sets a mutation pending BEFORE its mutationFn
 * issues the wallet call, so hook traffic always matches and the wrapper
 * stands down.
 */
describe("wagmi hybrid capture", () => {
  const ADDR = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const TO = "0x88C0224CEABF6D559d7B622F2918b308285280DE";

  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;
  // globalThis included: an earlier spec assigns it to a jsdom window and
  // never restores it, and this spec builds a REAL FormoAnalytics whose
  // event queue reads it.
  const GLOBAL_KEYS = [
    "window","globalThis","document","location","navigator","localStorage","sessionStorage",
    "Event","CustomEvent","addEventListener","removeEventListener","dispatchEvent","crypto",
  ] as const;

  beforeEach(() => {
    __resetSeededWallet();
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
  });

  afterEach(() => {
    sandbox.restore();
    savedGlobals.forEach((desc, k) => {
      if (desc) Object.defineProperty(global, k, desc);
      else delete (global as any)[k];
    });
    jsdom?.window.close();
  });

  const makeProvider = () => {
    const p: any = {
      chainId: "0x1",
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "personal_sign") return "0xsigned";
        if (method === "eth_sendTransaction") return "0x" + "ef".repeat(32);
        if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x1" };
        return null;
      },
    };
    return p;
  };

  const pendingMutations: Array<{
    state: { status: string; variables?: Record<string, unknown> };
    options: { mutationKey: string[] };
  }> = [];

  async function setup() {
    pendingMutations.length = 0;
    const provider = makeProvider();
    const connections = new Map();
    connections.set("c1", {
      accounts: [ADDR],
      chainId: 1,
      connector: {
        id: "metamask",
        name: "MetaMask",
        type: "injected",
        uid: "1",
        getProvider: async () => provider,
      },
    });
    const state = { status: "connected", connections, current: "c1", chainId: 1 };
    const config: any = {
      subscribe: () => () => undefined,
      getState: () => state,
      state,
    };
    const queryClient: any = {
      getMutationCache: () => ({
        subscribe: () => () => undefined,
        getAll: () => pendingMutations,
      }),
      getQueryCache: () => ({ subscribe: () => () => undefined }),
    };
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      wagmi: { config, queryClient },
    });
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    // The wrap resolves through connector.getProvider's microtask.
    await new Promise((r) => setTimeout(r, 20));
    return { formo, sent, provider };
  }

  const settle = () => new Promise((r) => setTimeout(r, 40));

  it("captures an imperative personal_sign that creates no mutation", async () => {
    const { formo, sent, provider } = await setup();

    await provider.request({ method: "personal_sign", params: ["0x68656c6c6f", ADDR] });
    await settle();

    const statuses = sent.filter((e) => e.type === "signature").map((e) => e.status);
    expect(statuses).to.deep.equal(["requested", "confirmed"]);
    formo.cleanup?.();
  });

  it("captures an imperative eth_sendTransaction end to end", async () => {
    const { formo, sent, provider } = await setup();

    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDR, to: TO, value: "0x0" }],
    });
    await settle();

    const statuses = sent.filter((e) => e.type === "transaction").map((e) => e.status);
    expect(statuses).to.include.members(["started", "broadcasted"]);
    formo.cleanup?.();
  });

  it("stands down when a pending mutation owns the request", async () => {
    const { formo, sent, provider } = await setup();
    pendingMutations.push({
      state: { status: "pending", variables: { message: "hello" } },
      options: { mutationKey: ["signMessage"] },
    });

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(sent.filter((e) => e.type === "signature")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("still captures when the pending mutation is for a DIFFERENT transaction", async () => {
    const { formo, sent, provider } = await setup();
    pendingMutations.push({
      state: { status: "pending", variables: { to: "0x000000000000000000000000000000000000dEaD" } },
      options: { mutationKey: ["sendTransaction"] },
    });

    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDR, to: TO, value: "0x0" }],
    });
    await settle();

    expect(
      sent.filter((e) => e.type === "transaction").map((e) => e.status)
    ).to.include.members(["started", "broadcasted"]);
    formo.cleanup?.();
  });

  it("ignores settled mutations - only pending ones stand the wrapper down", async () => {
    const { formo, sent, provider } = await setup();
    pendingMutations.push({
      state: { status: "success", variables: { message: "old" } },
      options: { mutationKey: ["signMessage"] },
    });

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(sent.filter((e) => e.type === "signature").length).to.equal(2);
    formo.cleanup?.();
  });
});
