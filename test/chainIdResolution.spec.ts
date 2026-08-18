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

    const mockWagmiConfig = {
      subscribe: sandbox.stub().returns(() => {}),
      state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
      _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
    };
    const mockQueryClient = {
      getMutationCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
      getQueryCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
    };

    formo = await FormoAnalytics.init("test-write-key", {
      wagmi: { config: mockWagmiConfig as any, queryClient: mockQueryClient as any },
    });
  });

  afterEach(() => {
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
    (formo as any)._provider = stalled;
    (formo as any).clearChainState("evm");

    const clock = sandbox.useFakeTimers({ shouldAdvanceTime: true });
    const pending = (formo as any).resolveChainIdForProvider(stalled);
    await clock.tickAsync(2100);
    clock.restore();

    expect(await pending).to.equal(0);
  });

  it("clears the timeout once the lookup settles", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).clearChainState("evm");
    const clearSpy = sandbox.spy(global, "clearTimeout");

    const resolved = await (formo as any).resolveChainIdForProvider(active);

    expect(resolved).to.equal(ACTIVE_CHAIN);
    // Otherwise every autocaptured request leaves a live 2s timer behind.
    expect(clearSpy.called).to.be.true;
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
