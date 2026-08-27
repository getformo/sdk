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

  type Subscription = {
    selector: (s: unknown) => unknown;
    listener: (next: unknown, prev: unknown) => void;
  };

  type SetupOpts = {
    /** Reuse an existing provider (remount / side-by-side scenarios). */
    provider?: any;
    /** Reuse existing wagmi state (remount / side-by-side scenarios). */
    state?: any;
    /** Chain the store reports for the connection. */
    chainId?: number;
    /** Collects every config.subscribe call so tests can fire updates. */
    subscriptions?: Subscription[];
  };

  function makeState(provider: any, chainId: number) {
    const connections = new Map();
    connections.set("c1", {
      accounts: [ADDR],
      chainId,
      connector: {
        id: "metamask",
        name: "MetaMask",
        type: "injected",
        uid: "1",
        getProvider: async () => provider,
      },
    });
    return { status: "connected", connections, current: "c1", chainId };
  }

  async function setup(eip1193Fallback = true, opts: SetupOpts = {}) {
    pendingMutations.length = 0;
    const provider = opts.provider ?? makeProvider();
    const state = opts.state ?? makeState(provider, opts.chainId ?? 1);
    const config: any = {
      subscribe: (selector: any, listener: any) => {
        opts.subscriptions?.push({ selector, listener });
        return () => undefined;
      },
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
      wagmi: { config, queryClient, eip1193Fallback },
    });
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    // The wrap resolves through connector.getProvider's microtask.
    await new Promise((r) => setTimeout(r, 20));
    return { formo, sent, provider, state };
  }

  const settle = () => new Promise((r) => setTimeout(r, 40));

  /**
   * Apply a store mutation the way wagmi/zustand reports it: run every
   * subscription's selector before and after, and notify ONLY the
   * subscriptions whose selected value actually changed.
   */
  function fireStoreUpdate(
    subscriptions: Subscription[],
    state: any,
    mutate: () => void
  ) {
    const prev = subscriptions.map((s) => s.selector(state));
    mutate();
    subscriptions.forEach((s, i) => {
      const next = s.selector(state);
      if (next !== prev[i]) s.listener(next, prev[i]);
    });
  }

  /** Replace a connection record wholesale, as wagmi does on updates. */
  function replaceConnection(state: any, id: string, patch: Record<string, unknown>) {
    state.connections.set(id, { ...state.connections.get(id), ...patch });
  }

  it("does NOT instrument the provider unless explicitly opted in", async () => {
    // Wagmi mode's baseline contract: observe state and caches, never
    // touch the signing transport. Instrumentation is opt-in.
    const { formo, sent, provider } = await setup(false);

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(sent.filter((e) => e.type === "signature")).to.deep.equal([]);
    formo.cleanup?.();
  });

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

  it("keeps capturing after an SDK remount over the same connection", async () => {
    // React strict/dev remounts rebuild the SDK. The wrap guard must not be
    // page-global: the new instance has to take ownership of the wrapper,
    // or captures die in the old instance's closed queue.
    const first = await setup();
    first.formo.cleanup?.();

    const second = await setup(true, { provider: first.provider, state: first.state });
    await second.provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await new Promise((r) => setTimeout(r, 40));

    expect(
      second.sent.filter((e) => e.type === "signature").length,
      "the remounted instance captures"
    ).to.equal(2);
    second.formo.cleanup?.();
  });

  it("routes captures to the NEWEST instance when two run side by side", async () => {
    // Two live instances over one connection: multiple write-key
    // destinations. The wrapper's owner list dispatches to the newest
    // non-disposed registrant, so the guard must let the second instance
    // register at all.
    const first = await setup();
    const second = await setup(true, { provider: first.provider, state: first.state });

    await second.provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      second.sent.filter((e) => e.type === "signature").length,
      "the newest instance captures"
    ).to.equal(2);
    expect(
      first.sent.filter((e) => e.type === "signature").length,
      "the older instance stands by"
    ).to.equal(0);
    second.formo.cleanup?.();
    first.formo.cleanup?.();
  });

  it("labels events with the store's chain when the provider has no sync chainId", async () => {
    // Standards-compliant providers need not expose a synchronous chainId
    // property, and the fallback wrapper is the ONLY capture path here, so
    // the registry would otherwise never learn the chain and events would
    // carry chain 0. The wagmi store knows; the wrap feeds it.
    const provider: any = {
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    };
    const { formo, sent } = await setup(true, { provider, chainId: 137 });

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    expect(chains).to.deep.equal([137, 137]);
    formo.cleanup?.();
  });

  it("follows chain switches reported by the wagmi store", async () => {
    const provider: any = {
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    };
    const subscriptions: Subscription[] = [];
    const { formo, sent, state } = await setup(true, {
      provider,
      chainId: 137,
      subscriptions,
    });

    // The store switches chains. Wagmi REPLACES the connection record.
    fireStoreUpdate(subscriptions, state, () => {
      state.chainId = 10;
      replaceConnection(state, "c1", { chainId: 10 });
    });
    await settle();

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    expect(chains).to.deep.equal([10, 10]);
    formo.cleanup?.();
  });

  it("records the chain that is live when a slow getProvider resolves", async () => {
    // connector.getProvider is asynchronous. A chain switch that lands
    // while it is in flight fires before the provider exists, so a chain
    // snapshot taken when the wrap was KICKED would stick as the recorded
    // chain. The wrap must read the store when it RESOLVES.
    const provider: any = {
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    };
    const state = makeState(provider, 137);
    state.connections.get("c1").connector.getProvider = () =>
      new Promise((resolve) => setTimeout(() => resolve(provider), 50));
    const subscriptions: Subscription[] = [];
    const { formo, sent } = await setup(true, { provider, state, subscriptions });

    // The wrap is still pending. Switch chains under it - as a record
    // replacement, which is how wagmi reports every update.
    fireStoreUpdate(subscriptions, state, () => {
      state.chainId = 10;
      replaceConnection(state, "c1", { chainId: 10 });
    });
    await new Promise((r) => setTimeout(r, 80));

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    expect(chains).to.deep.equal([10, 10]);
    formo.cleanup?.();
  });

  it("wraps the new provider when the active connector switches", async () => {
    // A connector switch keeps status "connected", so only the connection
    // subscription sees it. The new connection's provider must be wrapped
    // from there, and later chain reports must go to IT, not to the
    // previously wrapped provider.
    const makeBareProvider = () => ({
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    });
    const providerA: any = makeBareProvider();
    const providerB: any = makeBareProvider();
    const subscriptions: Subscription[] = [];
    const { formo, sent, state } = await setup(true, {
      provider: providerA,
      chainId: 137,
      subscriptions,
    });
    state.connections.set("c2", {
      accounts: [ADDR],
      chainId: 10,
      connector: {
        id: "rabby",
        name: "Rabby",
        type: "injected",
        uid: "2",
        getProvider: async () => providerB,
      },
    });

    fireStoreUpdate(subscriptions, state, () => {
      state.current = "c2";
      state.chainId = 10;
    });
    await settle();

    await providerB.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await providerA.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    // Two from provider B on ITS chain, then two from provider A still on
    // the chain it was wrapped with - B's report must not bleed onto A.
    expect(chains).to.deep.equal([10, 10, 137, 137]);
    formo.cleanup?.();
  });

  it("follows the chain again after switching BACK to a wrapped connector", async () => {
    // Switching back re-enters wrapActiveConnectorProvider with a
    // connector that is already wrapped. The chain-report target must be
    // repointed to it, or its later chain switches are silently dropped.
    const bare = () => ({
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    });
    const providerA: any = bare();
    const providerB: any = bare();
    const subscriptions: Subscription[] = [];
    const { formo, sent, state } = await setup(true, {
      provider: providerA,
      chainId: 137,
      subscriptions,
    });
    state.connections.set("c2", {
      accounts: [ADDR],
      chainId: 10,
      connector: {
        id: "rabby", name: "Rabby", type: "injected", uid: "2",
        getProvider: async () => providerB,
      },
    });

    fireStoreUpdate(subscriptions, state, () => {
      state.current = "c2";
      state.chainId = 10;
    });
    await settle();
    fireStoreUpdate(subscriptions, state, () => {
      state.current = "c1";
      state.chainId = 137;
    });
    await settle();
    // Connector A, active again, switches chains.
    fireStoreUpdate(subscriptions, state, () => {
      state.chainId = 42;
      replaceConnection(state, "c1", { chainId: 42 });
    });
    await settle();

    await providerA.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    expect(chains).to.deep.equal([42, 42]);
    formo.cleanup?.();
  });

  it("feeds the chain a connector moved to while it was INACTIVE", async () => {
    // While B is active, A's chain change does not move the chain
    // subscription's selected value, so nothing fires for it. When the
    // user switches back to A, the wrap kick must feed A's CURRENT chain,
    // not the one A had when it was last active.
    const bare = () => ({
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    });
    const providerA: any = bare();
    const providerB: any = bare();
    const subscriptions: Subscription[] = [];
    const { formo, sent, state } = await setup(true, {
      provider: providerA,
      chainId: 137,
      subscriptions,
    });
    state.connections.set("c2", {
      accounts: [ADDR],
      chainId: 10,
      connector: {
        id: "rabby", name: "Rabby", type: "injected", uid: "2",
        getProvider: async () => providerB,
      },
    });

    fireStoreUpdate(subscriptions, state, () => {
      state.current = "c2";
      state.chainId = 10;
    });
    await settle();
    // A switches to chain 42 in the background. Not the active
    // connection, so the chain subscription's selector does not move.
    fireStoreUpdate(subscriptions, state, () => {
      replaceConnection(state, "c1", { chainId: 42 });
    });
    // Back to A, which now reports 42.
    fireStoreUpdate(subscriptions, state, () => {
      state.current = "c1";
      state.chainId = 42;
    });
    await settle();

    await providerA.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    expect(chains).to.deep.equal([42, 42]);
    formo.cleanup?.();
  });

  it("wraps the REPLACEMENT provider a connector hands out after a reconnect", async () => {
    // Connector identity is stable but provider identity is not: a
    // disconnect/reconnect can produce a fresh provider object (a new
    // WalletConnect session, say). A once-only wrap guard would leave the
    // new session's provider unwrapped forever.
    const bare = () => ({
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    });
    const provider1: any = bare();
    const provider2: any = bare();
    let session = provider1;
    const subscriptions: Subscription[] = [];
    const state = makeState(provider1, 1);
    state.connections.get("c1").connector.getProvider = async () => session;
    const { formo, sent } = await setup(true, { provider: provider1, state, subscriptions });

    // The session dies and reconnects with a NEW provider object.
    fireStoreUpdate(subscriptions, state, () => {
      state.status = "disconnected";
    });
    await settle();
    session = provider2;
    fireStoreUpdate(subscriptions, state, () => {
      state.status = "connected";
    });
    await settle();

    await provider2.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      sent.filter((e) => e.type === "signature").length,
      "the reconnected session's provider is captured"
    ).to.equal(2);
    formo.cleanup?.();
  });

  it("discards an out-of-order resolution from a superseded wrap kick", async () => {
    // Two wrap kicks race: the FIRST getProvider() resolves LAST, with a
    // provider from the earlier session. The epoch must discard it - it
    // must neither be wrapped nor steal the chain-report target from the
    // provider the newer kick installed.
    const bare = () => ({
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    });
    const providerOld: any = bare();
    const providerNew: any = bare();
    let call = 0;
    const subscriptions: Subscription[] = [];
    const state = makeState(providerNew, 1);
    state.connections.get("c1").connector.getProvider = () => {
      call += 1;
      return call === 1
        ? new Promise((resolve) => setTimeout(() => resolve(providerOld), 60))
        : Promise.resolve(providerNew);
    };
    const { formo, sent } = await setup(true, { provider: providerNew, state, subscriptions });

    // Second kick, resolving immediately with the new session's provider.
    fireStoreUpdate(subscriptions, state, () => {
      replaceConnection(state, "c1", {
        accounts: ["0x88C0224CEABF6D559d7B622F2918b308285280DE"],
      });
    });
    // Let the FIRST kick's slow resolution arrive after the second.
    await new Promise((r) => setTimeout(r, 90));

    // Chain reports must land on the NEW provider...
    fireStoreUpdate(subscriptions, state, () => {
      state.chainId = 42;
      replaceConnection(state, "c1", { chainId: 42 });
    });
    await settle();
    await providerNew.request({ method: "personal_sign", params: ["0x68", ADDR] });
    // ...and the old provider must not have been wrapped at all.
    await providerOld.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const chains = sent.filter((e) => e.type === "signature").map((e) => e.chainId);
    expect(chains, "only the new provider is captured, on the live chain").to.deep.equal([42, 42]);
    formo.cleanup?.();
  });

  it("retries the wrap after the tracker refuses a provider", async () => {
    // registerRequestListeners reports refusals (a frozen provider, an
    // unrebindable wrapper) by returning false, not by throwing. The
    // connector guard must be dropped on refusal, or the connector can
    // never be wrapped for the rest of the session.
    const good: any = {
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) =>
        method === "personal_sign" ? "0xsigned" : null,
    };
    const frozen: any = Object.freeze({
      on: () => undefined,
      removeListener: () => undefined,
      request: async () => null,
    });
    let resolutions = 0;
    const subscriptions: Subscription[] = [];
    const provider: any = good;
    const state = makeState(provider, 1);
    state.connections.get("c1").connector.getProvider = async () =>
      resolutions++ === 0 ? frozen : good;
    const { formo, sent } = await setup(true, { provider, state, subscriptions });

    // First resolution handed over the frozen provider; the wrap refused.
    // A later connection update must retry, not be guard-blocked.
    fireStoreUpdate(subscriptions, state, () => {
      replaceConnection(state, "c1", {
        accounts: ["0x88C0224CEABF6D559d7B622F2918b308285280DE"],
      });
    });
    await settle();

    await good.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      sent.filter((e) => e.type === "signature").length,
      "the retried wrap captures"
    ).to.equal(2);
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
