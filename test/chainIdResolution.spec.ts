import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: an autocaptured signature or transaction must be tagged with the
 * chain of the provider that actually handled it.
 *
 * `_evmChainId` is maintained by `chainChanged` from whichever provider is
 * active. A visitor with two wallets installed can sign through the inactive
 * one, and reading the cache there attributes the event to the wrong chain.
 */
describe("Chain id resolution for autocaptured requests", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let formo: FormoAnalytics;
  let created: FormoAnalytics[] = [];
  let makeFormo: (options?: Record<string, unknown>) => Promise<FormoAnalytics>;

  const ADDRESS = "0x51377e9b985bb90b7c091b9a7d30c93d4c9c1cef";
  const ACTIVE_CHAIN = 1;
  const OTHER_CHAIN = 8453;

  const providerOnChain = (chainId: number) => ({
    request: sandbox.stub().resolves(`0x${chainId.toString(16)}`),
    on: sandbox.stub(),
    removeListener: sandbox.stub(),
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com",
    });
    for (const [key, value] of [
      ["window", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["globalThis", jsdom.window],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
    ] as const) {
      Object.defineProperty(global, key, {
        value, writable: true, configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid-1234" },
      writable: true, configurable: true,
    });

    initStorageManager("test-write-key");

    // Every instance built by a test, torn down in afterEach. An SDK instance
    // owns queue flush timers and provider listeners; leaking them keeps the
    // mocha process alive long after the assertions finish.
    created = [];
    makeFormo = async (options: Record<string, unknown> = {}) => {
      const instance = await FormoAnalytics.init("test-write-key", {
        wagmi: {
          config: {
            subscribe: sandbox.stub().returns(() => {}),
            state: {
              status: "disconnected",
              connections: new Map(),
              current: undefined,
              chainId: undefined,
            },
            _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
          } as any,
          queryClient: {
            getMutationCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
            getQueryCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
          } as any,
        },
        ...options,
      });
      // A broadcasted transaction starts a receipt poll that retries on a
      // multi-second timer. These mocks never return a recognisable receipt,
      // so the poll would run to exhaustion and hold the process open for
      // roughly 28 seconds on top of every run. No test here asserts on
      // receipts.
      sandbox.stub(instance as any, "pollTransactionReceipt").resolves(undefined);
      created.push(instance);
      return instance;
    };

    formo = await makeFormo();
  });

  afterEach(() => {
    for (const instance of created) {
      try {
        instance.cleanup();
      } catch {
        /* an instance may already be torn down */
      }
    }
    created = [];
    sandbox.restore();
    for (const key of [
      "window", "document", "location", "globalThis",
      "navigator", "localStorage", "sessionStorage", "crypto",
    ]) {
      delete (global as any)[key];
    }
    if (jsdom) jsdom.window.close();
  });

  it("uses the signing provider's chain when it is not the active provider", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    const other = providerOnChain(OTHER_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      other
    );

    expect(payload.chainId).to.equal(OTHER_CHAIN);
    expect(other.request.calledWithMatch({ method: "eth_chainId" })).to.be.true;
  });

  it("reads the cache for the active provider without an extra eth_chainId call", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      active
    );

    expect(payload.chainId).to.equal(ACTIVE_CHAIN);
    // The signature path awaits this before opening the wallet prompt, so the
    // common case must not pay for a round trip.
    expect(active.request.called).to.be.false;
  });

  it("reports unknown rather than the active chain when the other provider cannot answer", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    const broken = {
      request: sandbox.stub().rejects(new Error("no")),
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
    };
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      broken as any
    );

    // The cached chain belongs to a different wallet, so it is known-wrong
    // here. 0 is the honest answer.
    expect(payload.chainId).to.equal(0);
  });

  it("asks the signing provider when no active provider is established yet", async () => {
    // loadActiveWallet() restores a persisted chainId with no provider
    // attached; a request arriving before connect must not inherit it.
    (formo as any)._provider = undefined;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });
    const signer = providerOnChain(OTHER_CHAIN);

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      signer
    );

    expect(payload.chainId).to.equal(OTHER_CHAIN);
  });

  it("forwards a signature immediately even if the chain lookup hangs", async () => {
    // A stalled or disconnected wallet can leave eth_chainId pending forever.
    // The analytics lookup must never hold the wallet prompt closed.
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    let signatureForwarded = false;
    const stalled: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return new Promise(() => undefined); // never settles
        signatureForwarded = true;
        return "0xsigned";
      }),
    };

    (formo as any).registerRequestListeners(stalled);
    const result = await stalled.request({
      method: "personal_sign",
      params: ["0x68690000", ADDRESS],
    });

    expect(signatureForwarded).to.be.true;
    expect(result).to.equal("0xsigned");
  });

  it("reuses one chain snapshot across a transaction's statuses", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    // A wallet that reports a different chain on each call, as it would if the
    // user switched network while the prompt was open.
    let call = 0;
    const drifting: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${(++call === 1 ? 1 : 137).toString(16)}`;
        return "0xtxhash";
      }),
    };
    const seen: number[] = [];
    sandbox.stub(formo, "transaction").callsFake((async (p: any) => {
      seen.push(p.chainId);
    }) as any);

    (formo as any).registerRequestListeners(drifting);
    await drifting.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen.length).to.be.greaterThan(1);
    expect(new Set(seen).size).to.equal(1);
  });

  it("tags a rejected signature with the same shared chain", async () => {
    // The 4001 path reads the same shared promise as REQUESTED, so a user
    // declining in the wallet must still be attributed to the right chain.
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const seen: any[] = [];
    sandbox.stub(formo, "signature").callsFake((async (p: any) => { seen.push(p); }) as any);

    const rejecting: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${OTHER_CHAIN.toString(16)}`;
        const err: any = new Error("User rejected");
        err.code = 4001;
        throw err;
      }),
    };

    (formo as any).registerRequestListeners(rejecting);
    try {
      await rejecting.request({
        method: "personal_sign",
        params: ["0x68690000", ADDRESS],
      });
    } catch {
      /* the wallet's rejection must still propagate to the caller */
    }
    await new Promise((r) => setTimeout(r, 20));

    const rejected = seen.find((e) => e.status === "rejected");
    expect(rejected, "a rejected signature event").to.exist;
    expect(rejected.chainId).to.equal(OTHER_CHAIN);
  });

  it("tags a rejected transaction with the same shared chain", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const seen: any[] = [];
    sandbox.stub(formo, "transaction").callsFake((async (p: any) => { seen.push(p); }) as any);

    const rejecting: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${OTHER_CHAIN.toString(16)}`;
        const err: any = new Error("User rejected");
        err.code = 4001;
        throw err;
      }),
    };

    (formo as any).registerRequestListeners(rejecting);
    try {
      await rejecting.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      });
    } catch {
      /* propagates */
    }
    await new Promise((r) => setTimeout(r, 20));

    const statuses = seen.map((e) => e.status);
    expect(statuses).to.include("rejected");
    // Every status of this one call shares the snapshot.
    expect(new Set(seen.map((e) => e.chainId)).size).to.equal(1);
    expect(seen[0].chainId).to.equal(OTHER_CHAIN);
  });

  it("time-boxes the active provider too when nothing is cached", async () => {
    // The empty-cache path goes to the active provider, which can stall just
    // as easily; without a ceiling the dependent event is stranded forever.
    const stalled: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(() => new Promise(() => undefined)),
    };
    // Order matters. `clearChainState("evm")` replaces the whole evm
    // namespace, and the active provider lives inside it - clearing after
    // assigning would wipe the provider and send this down the
    // mismatched-provider branch instead of the empty-cache one under test.
    (formo as any).clearChainState("evm");
    (formo as any)._provider = stalled;
    expect((formo as any)._provider, "active provider is set").to.equal(stalled);
    expect((formo as any)._evmChainId, "no cached chain").to.be.undefined;

    const clock = sandbox.useFakeTimers({ shouldAdvanceTime: true });
    const pending = (formo as any).resolveChainIdForProvider(stalled);
    await clock.tickAsync(2100);
    clock.restore();

    expect(await pending).to.equal(0);
  });

  it("clears the timeout once the lookup settles", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any).clearChainState("evm");
    (formo as any)._provider = active;
    const clearSpy = sandbox.spy(global, "clearTimeout");

    const resolved = await (formo as any).resolveChainIdForProvider(active);

    expect(resolved).to.equal(ACTIVE_CHAIN);
    // Otherwise every autocaptured request leaves a live 2s timer behind.
    expect(clearSpy.called).to.be.true;
  });

  it("excludes an event on the signing provider's chain, not the active one", async () => {
    // The whole point of resolving the signer's chain is lost if the exclusion
    // gate still reads the active provider's. Active chain 1 is allowed, the
    // secondary signer is on excluded 8453, so nothing may be emitted.
    const excluded = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((excluded as any).eventManager, "addEvent").resolves();

    const active = providerOnChain(ACTIVE_CHAIN);
    (excluded as any)._provider = active;
    (excluded as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const other: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${OTHER_CHAIN.toString(16)}`;
        return "0xsigned";
      }),
    };
    (excluded as any).registerRequestListeners(other);
    await other.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.called, "excluded chain must not be tracked").to.be.false;
  });

  it("still emits when the active chain is excluded but the signer's is not", async () => {
    // The inverse. Reading the central field would drop a perfectly allowed
    // event because the *other* wallet happens to sit on an excluded chain.
    const excluded = await makeFormo({ tracking: { excludeChains: [ACTIVE_CHAIN] } });
    const addEvent = sandbox.stub((excluded as any).eventManager, "addEvent").resolves();

    const active = providerOnChain(ACTIVE_CHAIN);
    (excluded as any)._provider = active;
    (excluded as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const other: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${OTHER_CHAIN.toString(16)}`;
        return "0xsigned";
      }),
    };
    (excluded as any).registerRequestListeners(other);
    await other.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.called, "allowed chain must still be tracked").to.be.true;
  });

  it("issues the wallet request before starting the chain lookup", async () => {
    // A provider that serializes RPC - WalletConnect's relay socket - runs
    // requests in the order it receives them. If the chain lookup goes first,
    // a stalled lookup holds the wallet prompt closed no matter what the SDK
    // does with its own promise.
    const order: string[] = [];
    const serialized: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        order.push(method);
        if (method === "eth_chainId") return `0x${ACTIVE_CHAIN.toString(16)}`;
        return "0xsigned";
      }),
    };

    (formo as any).registerRequestListeners(serialized);
    await serialized.request({
      method: "personal_sign",
      params: ["0x68690000", ADDRESS],
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(order[0], `saw ${order.join(" then ")}`).to.equal("personal_sign");
  });

  it("issues the transaction before starting the chain lookup", async () => {
    const order: string[] = [];
    const serialized: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        order.push(method);
        if (method === "eth_chainId") return `0x${ACTIVE_CHAIN.toString(16)}`;
        return "0xtxhash";
      }),
    };

    (formo as any).registerRequestListeners(serialized);
    await serialized.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(order[0], `saw ${order.join(" then ")}`).to.equal("eth_sendTransaction");
  });

  it("queries the provider when no chain is cached yet", async () => {
    const provider = providerOnChain(OTHER_CHAIN);

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      provider
    );

    expect(payload.chainId).to.equal(OTHER_CHAIN);
  });
});
