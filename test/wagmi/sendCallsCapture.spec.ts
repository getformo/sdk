import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { WagmiEventHandler, __resetSeededWallet } from "../../src/wagmi/WagmiEventHandler";
import {
  WagmiState,
  QueryClient,
  MutationCacheEvent,
  QueryCacheEvent,
} from "../../src/wagmi/types";

/**
 * EIP-5792 batched calls, wagmi path (#360).
 *
 * 1.36.0's batch capture lived only in the EIP-1193 request wrapper, which
 * wagmi mode never installs; a `useSendCalls` mutation was silently ignored
 * - the same silent-loss shape as #331, in the mode most React dapps run.
 * These tests drive the handler through the mutation and query cache events
 * wagmi actually produces (mutation key `sendCalls`, query key `callsStatus`
 * shared by useCallsStatus and useWaitForCallsStatus in wagmi 2 and 3).
 */
describe("WagmiEventHandler EIP-5792 sendCalls", () => {
  const ADDRESS = "0x1234567890123456789012345678901234567890";
  const TO_A = "0x88C0224CEABF6D559d7B622F2918b308285280DE";
  const TO_B = "0x2F4bD6D2A5b7a19a49b6Cf2C0a0F1A5d33e8b7C1";

  let sandbox: sinon.SinonSandbox;
  let mockFormo: any;
  let mockWagmiConfig: any;
  let mockQueryClient: QueryClient;
  let mutationListener: ((event: MutationCacheEvent) => void) | null;
  let queryListener: ((event: QueryCacheEvent) => void) | null;
  let handler: WagmiEventHandler;

  const connectedState = (): WagmiState => {
    const connections = new Map();
    connections.set("connector-1", {
      accounts: [ADDRESS],
      chainId: 137,
      connector: { id: "metamask", name: "MetaMask", type: "injected", uid: "1" },
    });
    return { status: "connected", connections, current: "connector-1", chainId: 137 };
  };

  beforeEach(() => {
    __resetSeededWallet();
    sandbox = sinon.createSandbox();
    mutationListener = null;
    queryListener = null;

    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
      syncWalletState: sandbox.stub().callsFake((params: any) => {
        mockFormo.currentAddress = params?.address;
        mockFormo.currentChainId = params?.chainId;
      }),
      willTrackEvent: sandbox.stub().returns(true),
      currentAddress: undefined,
      currentChainId: undefined,
      writeKey: "test-write-key",
    };

    const state = connectedState();
    mockWagmiConfig = {
      subscribe: sandbox.stub().returns(() => undefined),
      getState: sandbox.stub().returns(state),
      state,
    };

    mockQueryClient = {
      getMutationCache: sandbox.stub().returns({
        subscribe: (listener: any) => {
          mutationListener = listener;
          return () => {
            mutationListener = null;
          };
        },
      }),
      getQueryCache: sandbox.stub().returns({
        subscribe: (listener: any) => {
          queryListener = listener;
          return () => {
            queryListener = null;
          };
        },
      }),
    } as any;

    handler = new WagmiEventHandler(mockFormo, mockWagmiConfig, mockQueryClient);
  });

  afterEach(() => {
    handler?.cleanup?.();
    sandbox.restore();
  });

  const CALLS = [
    { to: TO_A, value: BigInt(1), data: "0xaa" },
    { to: TO_B, value: BigInt(2), data: "0xbb" },
  ];

  let nextMutationId = 100;
  const sendMutation = (
    state: Record<string, unknown>,
    variables: Record<string, unknown> = { calls: CALLS },
    mutationId?: number
  ) => {
    const id = mutationId ?? (nextMutationId += 1);
    mutationListener?.({
      type: "updated",
      mutation: {
        mutationId: id,
        options: { mutationKey: ["sendCalls"] },
        state: { variables, ...state },
      },
    } as any);
    return id;
  };

  const callsStatusQuery = (id: string, data: unknown, status = "success") => {
    queryListener?.({
      type: "updated",
      query: {
        queryHash: `callsStatus-${id}-${JSON.stringify(data)?.length ?? 0}`,
        queryKey: ["callsStatus", { id }],
        state: { status, data },
      },
    } as any);
  };

  const emitted = (status: string) =>
    mockFormo.transaction.getCalls().filter((c: any) => c.args[0].status === status);

  it("emits one started per call at pending, with batch position and no id", () => {
    sendMutation({ status: "pending" });

    const started = emitted("started");
    expect(started.length).to.equal(2);
    expect(started.map((c: any) => c.args[0].to)).to.deep.equal([TO_A, TO_B]);
    expect(started.map((c: any) => c.args[1].batch_index)).to.deep.equal([0, 1]);
    for (const c of started) {
      expect(c.args[1].batch_size).to.equal(2);
      expect(c.args[1].batch_id).to.equal(undefined);
      expect(c.args[0].chainId).to.equal(137);
      expect(c.args[0].address).to.equal(ADDRESS);
    }
  });

  it("emits one broadcasted per call with the batch id on success", () => {
    sendMutation({ status: "success", data: { id: "0xbatch1" } });

    const broadcast = emitted("broadcasted");
    expect(broadcast.length).to.equal(2);
    for (const c of broadcast) {
      expect(c.args[1].batch_id).to.equal("0xbatch1");
    }
    expect(broadcast.map((c: any) => c.args[0].value)).to.deep.equal(["1", "2"]);
  });

  it("accepts a bare string id from a wallet on the earlier draft", () => {
    sendMutation({ status: "success", data: "0xolddraft" });

    expect(emitted("broadcasted")[0].args[1].batch_id).to.equal("0xolddraft");
  });

  it("uses the chain the batch names, not the connection's", () => {
    sendMutation({ status: "pending" }, { calls: CALLS, chainId: 8453 });

    expect(emitted("started")[0].args[0].chainId).to.equal(8453);
  });

  it("rejects every call when the user dismisses the prompt, even nested", () => {
    // viem wraps the RPC error; the 4001 sits under `cause`.
    const error = new Error("User rejected the request.");
    (error as any).cause = { code: 4001 };
    sendMutation({ status: "error", error });

    expect(emitted("rejected").length).to.equal(2);
  });

  it("emits nothing further for a wallet that does not support batches", () => {
    // A method-not-supported error is not a user decision; inventing a
    // rejection would miscount. Drive the real lifecycle - the mutation goes
    // pending, then errors - so the assertion covers what actually happens:
    // STARTED is all there is.
    const id = sendMutation({ status: "pending" });
    sendMutation(
      { status: "error", error: Object.assign(new Error("nope"), { code: -32601 }) },
      { calls: CALLS },
      id
    );

    expect(emitted("started").length).to.equal(2);
    expect(emitted("rejected").length).to.equal(0);
  });

  it("settles an atomic batch as one shared receipt across every call", () => {
    sendMutation({ status: "success", data: { id: "0xbatch2" } });
    // viem-formatted: statusCode numeric, receipt status as a string.
    callsStatusQuery("0xbatch2", {
      status: "success",
      statusCode: 200,
      atomic: true,
      receipts: [{ status: "success", transactionHash: "0xatomic" }],
    });

    const confirmed = emitted("confirmed");
    expect(confirmed.length).to.equal(2);
    expect(confirmed.map((c: any) => c.args[0].transactionHash)).to.deep.equal([
      "0xatomic",
      "0xatomic",
    ]);
    for (const c of confirmed) {
      expect(c.args[1].batch_id).to.equal("0xbatch2");
    }
  });

  it("lets a per-call receipt outrank the batch verdict on a partial revert", () => {
    sendMutation({ status: "success", data: { id: "0xbatch3" } });
    callsStatusQuery("0xbatch3", {
      statusCode: 600,
      atomic: false,
      receipts: [
        { status: "success", transactionHash: "0xok" },
        { status: "reverted", transactionHash: "0xbad" },
      ],
    });

    expect(emitted("confirmed").length).to.equal(1);
    expect(emitted("reverted").length).to.equal(1);
    expect(emitted("reverted")[0].args[0].transactionHash).to.equal("0xbad");
  });

  it("does not share a single receipt when the wallet says atomic is false", () => {
    // A non-atomic batch whose execution stopped after one call mined is a
    // real shape: one receipt, atomic: false. Sharing that receipt would
    // hand the unmined call a transaction hash it does not have. The mined
    // call keeps its receipt; the other falls back to the batch verdict,
    // hashless.
    sendMutation({ status: "success", data: { id: "0xbatch7" } });
    callsStatusQuery("0xbatch7", {
      statusCode: 500,
      atomic: false,
      receipts: [{ status: "reverted", transactionHash: "0xonlymined" }],
    });

    const reverted = emitted("reverted");
    expect(reverted.length).to.equal(2);
    expect(reverted[0].args[0].transactionHash).to.equal("0xonlymined");
    expect(reverted[1].args[0].transactionHash).to.equal(undefined);
  });

  it("leaves a call unsettled when a partial batch gave it no receipt", () => {
    sendMutation({ status: "success", data: { id: "0xbatch4" } });
    callsStatusQuery("0xbatch4", {
      statusCode: 600,
      atomic: false,
      receipts: [{ status: "success", transactionHash: "0xonly" }],
    });

    expect(emitted("confirmed").length).to.equal(1);
    expect(emitted("reverted").length).to.equal(0);
  });

  it("keeps waiting while the batch is still pending, then settles once", () => {
    sendMutation({ status: "success", data: { id: "0xbatch5" } });
    callsStatusQuery("0xbatch5", { status: "pending", statusCode: 100 });
    expect(emitted("confirmed").length).to.equal(0);

    callsStatusQuery("0xbatch5", {
      statusCode: 200,
      atomic: true,
      receipts: [{ status: "success", transactionHash: "0xdone" }],
    });
    expect(emitted("confirmed").length).to.equal(2);

    // A refetch of the settled query must not re-emit.
    callsStatusQuery("0xbatch5", {
      statusCode: 200,
      atomic: true,
      receipts: [{ status: "success", transactionHash: "0xdone" }],
    });
    expect(emitted("confirmed").length).to.equal(2);
  });

  it("settles from a status refetch when the query beat the mutation", () => {
    // TanStack dispatches a mutation's success state AFTER its onSuccess
    // callbacks, so an app awaiting waitForCallsStatus inside onSuccess
    // produces the settled query first. That early event finds no
    // registered batch and must not poison deduplication: a later refetch
    // with the very same terminal result still settles the batch.
    const settled = {
      statusCode: 200,
      atomic: true,
      receipts: [{ status: "success", transactionHash: "0xearly" }],
    };
    callsStatusQuery("0xbatch8", settled);
    expect(emitted("confirmed").length).to.equal(0);

    sendMutation({ status: "success", data: { id: "0xbatch8" } });
    callsStatusQuery("0xbatch8", settled);
    expect(emitted("confirmed").length).to.equal(2);
  });

  it("settles from the cached query at registration, without a refetch", () => {
    // Same ordering, but the app never refetches. When the cache exposes
    // lookup, registration itself finds the already-settled query.
    const settled = {
      statusCode: 200,
      atomic: true,
      receipts: [{ status: "success", transactionHash: "0xcached" }],
    };
    const cachedQuery = {
      queryKey: ["callsStatus", { id: "0xbatch9" }],
      state: { status: "success", data: settled },
    };
    (mockQueryClient.getQueryCache as any).returns({
      subscribe: (listener: any) => {
        queryListener = listener;
        return () => {
          queryListener = null;
        };
      },
      getAll: () => [cachedQuery],
    });

    callsStatusQuery("0xbatch9", settled);
    expect(emitted("confirmed").length).to.equal(0);

    sendMutation({ status: "success", data: { id: "0xbatch9" } });
    expect(emitted("confirmed").length).to.equal(2);
    expect(emitted("confirmed")[0].args[0].transactionHash).to.equal("0xcached");
  });

  it("labels settlement with the chain the status result names", () => {
    // The mutation named no chain, so broadcast used the connection's (137).
    // The wallet moved chains before settling; EIP-5792 v2 reports where
    // the batch actually landed, and that outranks the stale inference.
    sendMutation({ status: "success", data: { id: "0xbatch10" } });
    callsStatusQuery("0xbatch10", {
      statusCode: 200,
      atomic: true,
      chainId: 8453,
      receipts: [{ status: "success", transactionHash: "0xmoved" }],
    });

    for (const c of emitted("confirmed")) {
      expect(c.args[0].chainId).to.equal(8453);
    }
  });

  it("keeps an explicitly named mutation chain over the settlement chain", () => {
    sendMutation(
      { status: "success", data: { id: "0xbatch11" } },
      { calls: CALLS, chainId: 10 }
    );
    callsStatusQuery("0xbatch11", {
      statusCode: 200,
      atomic: true,
      chainId: "0x2105",
      receipts: [{ status: "success", transactionHash: "0xexplicit" }],
    });

    for (const c of emitted("confirmed")) {
      expect(c.args[0].chainId).to.equal(10);
    }
  });

  it("ignores a callsStatus query for a batch this page never broadcast", () => {
    // Queries are visible to any code sharing the QueryClient; emitting for
    // an unobserved id would let a forged query invent transactions.
    callsStatusQuery("0xforged", {
      statusCode: 200,
      receipts: [{ status: "success", transactionHash: "0xfake" }],
    });

    expect(mockFormo.transaction.called).to.equal(false);
  });

  it("tracks nothing when transaction autocapture is off", () => {
    mockFormo.isAutocaptureEnabled.withArgs("transaction").returns(false);
    sendMutation({ status: "pending" });
    sendMutation({ status: "success", data: { id: "0xbatch6" } });

    expect(mockFormo.transaction.called).to.equal(false);
  });

  it("tracks nothing for an empty batch", () => {
    sendMutation({ status: "pending" }, { calls: [] });

    expect(mockFormo.transaction.called).to.equal(false);
  });
});
