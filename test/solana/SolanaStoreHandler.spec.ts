import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import { SolanaStoreHandler } from "../../src/solana/SolanaStoreHandler";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { SOLANA_CHAIN_IDS } from "../../src/solana/types";
import {
  SolanaClientStore,
  SolanaClientState,
  SolanaWalletStatus,
  SolanaTransactionRecord,
} from "../../src/solana/storeTypes";

describe("SolanaStoreHandler", () => {
  let sandbox: sinon.SinonSandbox;
  let mockFormo: sinon.SinonStubbedInstance<FormoAnalytics>;

  const MOCK_ADDRESS = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";

  // -- Mock Store Helper --

  function createMockStore(
    initialState?: Partial<SolanaClientState>
  ): SolanaClientStore & {
    _setState: (partial: Partial<SolanaClientState>) => void;
    _state: SolanaClientState;
  } {
    const defaultState: SolanaClientState = {
      transactions: {},
      wallet: { status: "disconnected" },
      cluster: { endpoint: "https://api.devnet.solana.com", status: "ready" },
      lastUpdatedAt: Date.now(),
      ...initialState,
    };

    let state = { ...defaultState };
    const listeners: Array<{
      selector?: (state: SolanaClientState) => unknown;
      listener: (...args: unknown[]) => void;
    }> = [];

    const store: SolanaClientStore & {
      _setState: (partial: Partial<SolanaClientState>) => void;
      _state: SolanaClientState;
    } = {
      getState: () => state,
      get _state() { return state; },

      subscribe: (
        selectorOrListener: unknown,
        listenerOrOptions?: unknown,
        _options?: unknown
      ): (() => void) => {
        if (typeof listenerOrOptions === "function") {
          // Selector-based subscription: subscribe(selector, listener, options?)
          const entry = {
            selector: selectorOrListener as (state: SolanaClientState) => unknown,
            listener: listenerOrOptions as (...args: unknown[]) => void,
          };
          listeners.push(entry);
          return () => {
            const idx = listeners.indexOf(entry);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        } else {
          // Full state subscription: subscribe(listener)
          const entry = {
            listener: selectorOrListener as (...args: unknown[]) => void,
          };
          listeners.push(entry);
          return () => {
            const idx = listeners.indexOf(entry);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        }
      },

      _setState(partial: Partial<SolanaClientState>) {
        const prev = { ...state };
        state = { ...state, ...partial };
        for (const entry of listeners) {
          if (entry.selector) {
            const prevSelected = entry.selector(prev);
            const selected = entry.selector(state);
            if (prevSelected !== selected) {
              entry.listener(selected, prevSelected);
            }
          } else {
            entry.listener(state, prev);
          }
        }
      },
    };

    return store;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
    } as any;
  });

  afterEach(() => {
    sandbox.restore();
  });

  // -- Constructor --

  describe("Constructor", () => {
    it("should initialize with default cluster", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store);
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      handler.cleanup();
    });

    it("should use provided cluster", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store, { cluster: "devnet" });
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      handler.cleanup();
    });
  });

  // -- Wallet Connect/Disconnect --

  describe("Wallet Connection Tracking", () => {
    it("should emit connect event when wallet transitions to connected", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store, { cluster: "devnet" });

      store._setState({
        wallet: {
          status: "connected",
          connectorId: "phantom",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "phantom", name: "Phantom" },
            disconnect: async () => {},
          },
        },
      });

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].address).to.equal(MOCK_ADDRESS);
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      expect(mockFormo.connect.firstCall.args[1]!.providerName).to.equal("Phantom");

      handler.cleanup();
    });

    it("should emit disconnect event when wallet transitions to disconnected", () => {
      const store = createMockStore({
        wallet: {
          status: "connected",
          connectorId: "phantom",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "phantom", name: "Phantom" },
            disconnect: async () => {},
          },
        },
      });
      const handler = new SolanaStoreHandler(mockFormo as any, store);

      // Initial connect event
      expect(mockFormo.connect.calledOnce).to.be.true;

      // Disconnect
      store._setState({ wallet: { status: "disconnected" } });

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.firstCall.args[0]!.address).to.equal(MOCK_ADDRESS);

      handler.cleanup();
    });

    it("should detect already-connected wallet on initialization", () => {
      const store = createMockStore({
        wallet: {
          status: "connected",
          connectorId: "solflare",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "solflare", name: "Solflare" },
            disconnect: async () => {},
          },
        },
      });

      const handler = new SolanaStoreHandler(mockFormo as any, store);

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].address).to.equal(MOCK_ADDRESS);

      handler.cleanup();
    });

    it("should not emit connect for disconnected wallet on init", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store);

      expect(mockFormo.connect.called).to.be.false;

      handler.cleanup();
    });

    it("should block system addresses", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store);

      store._setState({
        wallet: {
          status: "connected",
          connectorId: "test",
          session: {
            account: { address: "11111111111111111111111111111111" },
            connector: { id: "test", name: "Test" },
            disconnect: async () => {},
          },
        },
      });

      expect(mockFormo.connect.called).to.be.false;

      handler.cleanup();
    });
  });

  // -- Transaction Tracking --

  describe("Transaction Tracking", () => {
    let store: ReturnType<typeof createMockStore>;
    let handler: SolanaStoreHandler;

    beforeEach(() => {
      store = createMockStore({
        wallet: {
          status: "connected",
          connectorId: "phantom",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "phantom", name: "Phantom" },
            disconnect: async () => {},
          },
        },
      });
      handler = new SolanaStoreHandler(mockFormo as any, store);
      // Clear the connect call from init
      mockFormo.transaction.resetHistory();
    });

    afterEach(() => {
      handler.cleanup();
    });

    it("should emit STARTED when transaction enters sending state", () => {
      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });

      expect(mockFormo.transaction.calledOnce).to.be.true;
      expect(mockFormo.transaction.firstCall.args[0].status).to.equal("started");
      expect(mockFormo.transaction.firstCall.args[0].address).to.equal(MOCK_ADDRESS);
    });

    it("should emit BROADCASTED when transaction enters waiting state with signature", () => {
      // First: sending
      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });

      // Then: waiting (with signature)
      store._setState({
        transactions: {
          tx1: { status: "waiting", signature: "tx_sig_abc", lastUpdatedAt: Date.now() },
        },
      });

      expect(mockFormo.transaction.calledTwice).to.be.true;
      expect(mockFormo.transaction.secondCall.args[0].status).to.equal("broadcasted");
      expect(mockFormo.transaction.secondCall.args[0].transactionHash).to.equal("tx_sig_abc");
    });

    it("should emit CONFIRMED when transaction is confirmed", () => {
      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });
      store._setState({
        transactions: {
          tx1: { status: "confirmed", signature: "tx_sig_123", lastUpdatedAt: Date.now() },
        },
      });

      const lastCall = mockFormo.transaction.lastCall.args[0];
      expect(lastCall.status).to.equal("confirmed");
      expect(lastCall.transactionHash).to.equal("tx_sig_123");
    });

    it("should emit REVERTED when transaction fails after sending", () => {
      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });
      store._setState({
        transactions: {
          tx1: { status: "failed", error: "InstructionError", lastUpdatedAt: Date.now() },
        },
      });

      const lastCall = mockFormo.transaction.lastCall.args[0];
      expect(lastCall.status).to.equal("reverted");
    });

    it("should emit REJECTED when transaction fails before sending", () => {
      store._setState({
        transactions: {
          tx1: { status: "idle", lastUpdatedAt: Date.now() },
        },
      });
      store._setState({
        transactions: {
          tx1: { status: "failed", error: "User rejected", lastUpdatedAt: Date.now() },
        },
      });

      const lastCall = mockFormo.transaction.lastCall.args[0];
      expect(lastCall.status).to.equal("rejected");
    });

    it("should track multiple transactions independently", () => {
      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });
      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
          tx2: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });

      // tx1 STARTED + tx2 STARTED
      expect(mockFormo.transaction.callCount).to.equal(2);
    });

    it("should not emit events when not connected", () => {
      // Disconnect first
      store._setState({ wallet: { status: "disconnected" } });
      mockFormo.transaction.resetHistory();

      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });

      expect(mockFormo.transaction.called).to.be.false;
    });

    it("should deduplicate same transaction status", () => {
      const tx: SolanaTransactionRecord = { status: "sending", lastUpdatedAt: Date.now() };
      store._setState({ transactions: { tx1: tx } });
      // Force re-emit by creating new object reference
      store._setState({ transactions: { tx1: { ...tx, lastUpdatedAt: Date.now() + 1 } } });

      // Should only have one STARTED (deduplicated)
      expect(mockFormo.transaction.callCount).to.equal(1);
    });
  });

  // -- Autocapture Disabled --

  describe("Autocapture Disabled", () => {
    it("should not emit events when autocapture is disabled", () => {
      mockFormo.isAutocaptureEnabled.returns(false);

      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store);

      store._setState({
        wallet: {
          status: "connected",
          connectorId: "phantom",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "phantom", name: "Phantom" },
            disconnect: async () => {},
          },
        },
      });

      expect(mockFormo.connect.called).to.be.false;

      store._setState({
        transactions: {
          tx1: { status: "sending", lastUpdatedAt: Date.now() },
        },
      });

      expect(mockFormo.transaction.called).to.be.false;

      handler.cleanup();
    });
  });

  // -- setCluster --

  describe("setCluster", () => {
    it("should update chainId", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store, {
        cluster: "mainnet-beta",
      });

      handler.setCluster("devnet");
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["devnet"]);

      handler.cleanup();
    });

    it("should emit chain event when connected and cluster changes", () => {
      const store = createMockStore({
        wallet: {
          status: "connected",
          connectorId: "phantom",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "phantom", name: "Phantom" },
            disconnect: async () => {},
          },
        },
      });
      const handler = new SolanaStoreHandler(mockFormo as any, store, {
        cluster: "mainnet-beta",
      });

      handler.setCluster("devnet");

      expect(mockFormo.chain.calledOnce).to.be.true;
      expect(mockFormo.chain.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);

      handler.cleanup();
    });
  });

  // -- Cleanup --

  describe("Cleanup", () => {
    it("should unsubscribe from store on cleanup", () => {
      const store = createMockStore();
      const handler = new SolanaStoreHandler(mockFormo as any, store);

      handler.cleanup();

      // After cleanup, state changes should not trigger events
      store._setState({
        wallet: {
          status: "connected",
          connectorId: "phantom",
          session: {
            account: { address: MOCK_ADDRESS },
            connector: { id: "phantom", name: "Phantom" },
            disconnect: async () => {},
          },
        },
      });

      expect(mockFormo.connect.called).to.be.false;
    });
  });
});
