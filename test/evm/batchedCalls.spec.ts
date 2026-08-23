import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";

/**
 * EIP-5792 batched calls (#331).
 *
 * Smart accounts send through `wallet_sendCalls`, not `eth_sendTransaction`.
 * Until this the SDK understood only the latter, so those transactions were
 * not captured at all and nothing errored: the same silent-loss shape as the
 * missing-connect bug that started this work.
 *
 * The decision recorded on the issue: one `transaction` event PER CALL,
 * carrying the batch id so the calls can be reassembled downstream. A batch
 * maps to several on-chain transactions, so reporting it as one event would
 * understate volume and misattribute revenue.
 */
describe("EIP-5792 batched calls", () => {
  const FROM = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const TO_A = "0x88C0224CEABF6D559d7B622F2918b308285280DE";
  const TO_B = "0x2F4bD6D2A5b7a19a49b6Cf2C0a0F1A5d33e8b7C1";

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

  /** A provider whose `wallet_sendCalls` and status responses a test controls. */
  const makeProvider = (opts: {
    sendResult?: unknown;
    sendError?: unknown;
    status?: unknown;
  } = {}) => {
    const calls: string[] = [];
    const p: any = {
      chainId: "0x1",
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_accounts") return [FROM];
        if (method === "wallet_sendCalls") {
          if (opts.sendError) throw opts.sendError;
          return opts.sendResult ?? { id: "0xbatch1" };
        }
        if (method === "wallet_getCallsStatus") return opts.status ?? null;
        return null;
      },
      methodsCalled: calls,
    };
    return p;
  };

  const batchParams = (overrides: Record<string, unknown> = {}) => [
    {
      version: "2.0.0",
      from: FROM,
      chainId: "0x89",
      atomicRequired: true,
      calls: [
        { to: TO_A, value: "0x1", data: "0xaa" },
        { to: TO_B, value: "0x2", data: "0xbb" },
      ],
      ...overrides,
    },
  ];

  async function setup(provider: any, options: any = { tracking: true }) {
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", options);
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    (formo as any).evmRequests.registerRequestListeners(provider);
    return { formo, sent };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));
  const txs = (sent: any[]) => sent.filter((e) => e.type === "transaction");

  it("reports one event per call, not one per batch", async () => {
    const provider = makeProvider();
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    const started = txs(sent).filter((e) => e.status === "started");
    expect(started.length, "two calls means two events").to.equal(2);
    expect(started.map((e) => e.to)).to.deep.equal([TO_A, TO_B]);
    expect(started.map((e) => e.value)).to.deep.equal(["0x1", "0x2"]);
    formo.cleanup?.();
  });

  it("carries the batch id from broadcast onward so calls can be regrouped", async () => {
    const provider = makeProvider({ sendResult: { id: "0xdeadbeef" } });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    const broadcast = txs(sent).filter((e) => e.status === "broadcasted");
    expect(broadcast.length).to.equal(2);
    for (const e of broadcast) {
      expect(e.properties?.batch_id).to.equal("0xdeadbeef");
      expect(e.properties?.batch_size).to.equal(2);
    }
    expect(broadcast.map((e) => e.properties?.batch_index)).to.deep.equal([0, 1]);
    formo.cleanup?.();
  });

  it("accepts a bare string id from a wallet on the earlier draft", async () => {
    const provider = makeProvider({ sendResult: "0xolddraft" });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    const broadcast = txs(sent).filter((e) => e.status === "broadcasted");
    expect(broadcast[0].properties?.batch_id).to.equal("0xolddraft");
    formo.cleanup?.();
  });

  it("uses the chain the batch names, not the wallet's current one", async () => {
    // A batch can be sent to a chain the wallet is not sitting on.
    const provider = makeProvider();
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    expect(txs(sent)[0].chainId, "0x89 is 137").to.equal(137);
    formo.cleanup?.();
  });

  it("reports every call as rejected when the user dismisses the prompt", async () => {
    // One rejection dismisses the whole prompt, so reporting only the first
    // call would undercount.
    const provider = makeProvider({ sendError: Object.assign(new Error("nope"), { code: 4001 }) });
    const { formo, sent } = await setup(provider);

    await provider
      .request({ method: "wallet_sendCalls", params: batchParams() })
      .catch(() => undefined);
    await settle();

    expect(txs(sent).filter((e) => e.status === "rejected").length).to.equal(2);
    formo.cleanup?.();
  });

  it("confirms every call when the batch confirms", async () => {
    const provider = makeProvider({
      status: {
        status: 200,
        receipts: [
          { status: "0x1", transactionHash: "0xhashA" },
          { status: "0x1", transactionHash: "0xhashB" },
        ],
      },
    });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    const confirmed = txs(sent).filter((e) => e.status === "confirmed");
    expect(confirmed.length).to.equal(2);
    expect(confirmed.map((e) => e.transactionHash)).to.deep.equal(["0xhashA", "0xhashB"]);
    formo.cleanup?.();
  });

  it("lets a per-call receipt outrank the batch verdict", async () => {
    // A partially reverted non-atomic batch must report honestly rather than
    // marking every call with the batch's worst outcome. 600 is only
    // meaningful when the batch did not require atomicity.
    const provider = makeProvider({
      status: {
        status: 600,
        receipts: [
          { status: "0x1", transactionHash: "0xok" },
          { status: "0x0", transactionHash: "0xbad" },
        ],
      },
    });
    const { formo, sent } = await setup(provider);

    await provider.request({
      method: "wallet_sendCalls",
      params: batchParams({ atomicRequired: false }),
    });
    await settle();

    const outcomes = txs(sent)
      .filter((e) => e.status === "confirmed" || e.status === "reverted")
      .map((e) => e.status);
    expect(outcomes).to.deep.equal(["confirmed", "reverted"]);
    formo.cleanup?.();
  });

  it("reverts every call when the batch failed and gave no receipts", async () => {
    const provider = makeProvider({ status: { status: 500 } });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    expect(txs(sent).filter((e) => e.status === "reverted").length).to.equal(2);
    formo.cleanup?.();
  });

  it("keeps waiting while the batch is still pending", async () => {
    const provider = makeProvider({ status: { status: 100 } });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    const settled = txs(sent).filter(
      (e) => e.status === "confirmed" || e.status === "reverted"
    );
    expect(settled, "nothing is decided yet").to.deep.equal([]);
    formo.cleanup?.();
  });

  it("produces exactly one event per status for a single-call batch", async () => {
    // Indistinguishable in count from a plain eth_sendTransaction.
    const provider = makeProvider();
    const { formo, sent } = await setup(provider);

    await provider.request({
      method: "wallet_sendCalls",
      params: batchParams({ calls: [{ to: TO_A, value: "0x1", data: "0xaa" }] }),
    });
    await settle();

    expect(txs(sent).filter((e) => e.status === "started").length).to.equal(1);
    expect(txs(sent).filter((e) => e.status === "broadcasted").length).to.equal(1);
    formo.cleanup?.();
  });

  it("tracks nothing but still sends the batch when autocapture is off", async () => {
    const provider = makeProvider();
    const { formo, sent } = await setup(provider, {
      tracking: true,
      autocapture: { transaction: false },
    });

    const result = await provider.request({
      method: "wallet_sendCalls",
      params: batchParams(),
    });
    await settle();

    expect(txs(sent)).to.deep.equal([]);
    expect(result, "the user's call still goes through").to.deep.equal({ id: "0xbatch1" });
    formo.cleanup?.();
  });

  it("tracks nothing when the batch has no valid sender", async () => {
    // Inventing an address would be worse than reporting nothing.
    const provider = makeProvider();
    const { formo, sent } = await setup(provider);

    await provider.request({
      method: "wallet_sendCalls",
      params: batchParams({ from: "0xnot-an-address" }),
    });
    await settle();

    expect(txs(sent)).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("tracks nothing for an empty batch", async () => {
    const provider = makeProvider();
    const { formo, sent } = await setup(provider);

    await provider.request({
      method: "wallet_sendCalls",
      params: batchParams({ calls: [] }),
    });
    await settle();

    expect(txs(sent)).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("stops polling when the SDK is torn down", async () => {
    // A poll re-arms for up to thirty seconds. A torn-down instance that kept
    // asking would hold the process open for that whole window and keep
    // questioning a wallet nobody is listening to - the same shape as the
    // batch timer that hung the suite in #338.
    const provider = makeProvider({ status: { status: 100 } });
    const { formo } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    const before = provider.methodsCalled.filter(
      (m: string) => m === "wallet_getCallsStatus"
    ).length;
    expect(before, "it polled at least once").to.be.greaterThan(0);

    formo.cleanup();
    await new Promise((r) => setTimeout(r, 60));

    const tracker = (formo as any).evmRequests;
    expect(tracker.polls.size, "armed timers are cleared").to.equal(0);

    // And a poll already mid-flight when cleanup ran must not re-arm. Asking
    // the scheduler directly, because waiting out a 3s interval in a test is
    // exactly the cost this fix exists to remove.
    tracker.schedulePoll(() => undefined, 5000);
    expect(
      tracker.polls.size,
      "a torn-down tracker refuses to schedule anything further"
    ).to.equal(0);
  });

  it("reports a batch that failed before landing as rejected, not reverted", async () => {
    // EIP-5792 status 400 means the batch never made it on chain. Calling
    // that "reverted" would report gas spent and on-chain activity that
    // never happened.
    const provider = makeProvider({ status: { status: 400 } });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    expect(txs(sent).filter((e) => e.status === "rejected").length).to.equal(2);
    expect(txs(sent).filter((e) => e.status === "reverted")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("leaves a call unsettled when a partial batch gave it no receipt", async () => {
    // 600 means SOME calls reverted. Deciding a call the wallet said nothing
    // about would be inventing a result.
    const provider = makeProvider({
      status: { status: 600, receipts: [{ status: "0x1", transactionHash: "0xok" }] },
    });
    const { formo, sent } = await setup(provider);

    await provider.request({
      method: "wallet_sendCalls",
      params: batchParams({ atomicRequired: false }),
    });
    await settle();

    const settled = txs(sent).filter(
      (e) => e.status === "confirmed" || e.status === "reverted"
    );
    expect(settled.length, "only the call with a receipt is decided").to.equal(1);
    expect(settled[0].properties?.batch_index).to.equal(0);
    formo.cleanup?.();
  });

  it("falls back to the batch verdict when a receipt has no readable status", async () => {
    // An unreadable receipt must not be assumed good on a failed batch.
    const provider = makeProvider({
      status: { status: 500, receipts: [{ transactionHash: "0xa" }, { transactionHash: "0xb" }] },
    });
    const { formo, sent } = await setup(provider);

    await provider.request({ method: "wallet_sendCalls", params: batchParams() });
    await settle();

    expect(txs(sent).filter((e) => e.status === "reverted").length).to.equal(2);
    formo.cleanup?.();
  });
});
