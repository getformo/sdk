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

  it("queries the provider when no chain is cached yet", async () => {
    const provider = providerOnChain(OTHER_CHAIN);

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      provider
    );

    expect(payload.chainId).to.equal(OTHER_CHAIN);
  });
});
