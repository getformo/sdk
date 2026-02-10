import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import { SolanaWalletAdapterHandler } from "../../src/solana/SolanaWalletAdapterHandler";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import {
  SolanaWalletAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaPublicKey,
  SolanaTransaction,
  WalletReadyState,
  SOLANA_CHAIN_IDS,
  SolanaWalletEntry,
  isSolanaWalletContext,
  isSolanaWalletAdapter,
} from "../../src/solana/types";

describe("SolanaWalletAdapterHandler", () => {
  let sandbox: sinon.SinonSandbox;
  let mockFormo: sinon.SinonStubbedInstance<FormoAnalytics>;

  const MOCK_ADDRESS = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";
  const MOCK_ADDRESS_2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  // -- Helpers --

  const createMockPublicKey = (
    address: string = MOCK_ADDRESS
  ): SolanaPublicKey => ({
    toBase58: () => address,
    toString: () => address,
    toBytes: () => new Uint8Array(32),
    equals: () => false,
  });

  const createMockAdapter = (
    overrides: Partial<SolanaWalletAdapter> = {}
  ): SolanaWalletAdapter => {
    const listeners = new Map<string, Set<Function>>();
    return {
      name: "Test Wallet",
      url: "https://test.wallet",
      icon: "icon.png",
      readyState: WalletReadyState.Installed,
      publicKey: null,
      connecting: false,
      connected: false,
      connect: async () => {},
      disconnect: async () => {},
      on: ((event: string, listener: Function) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      }) as SolanaWalletAdapter["on"],
      off: ((event: string, listener: Function) => {
        listeners.get(event)?.delete(listener);
      }) as SolanaWalletAdapter["off"],
      // Helper to emit events in tests
      _emit: (event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach((fn) => fn(...args));
      },
      _listeners: listeners,
      ...overrides,
    } as SolanaWalletAdapter & {
      _emit: (event: string, ...args: unknown[]) => void;
      _listeners: Map<string, Set<Function>>;
    };
  };

  const createMockWalletEntry = (
    adapter: SolanaWalletAdapter
  ): SolanaWalletEntry => ({
    adapter,
    readyState: adapter.readyState,
  });

  const createMockContext = (
    adapter: SolanaWalletAdapter,
    overrides: Partial<SolanaWalletContext> = {}
  ): SolanaWalletContext => {
    const walletEntry = createMockWalletEntry(adapter);
    return {
      autoConnect: false,
      wallets: [walletEntry],
      wallet: walletEntry,
      publicKey: null,
      connecting: false,
      connected: false,
      disconnecting: false,
      select: () => {},
      connect: async () => {},
      disconnect: async () => {},
      sendTransaction: async () => "mock_signature",
      ...overrides,
    };
  };

  const createMockConnection = (
    overrides: Partial<SolanaConnection> = {}
  ): SolanaConnection => ({
    rpcEndpoint: "https://api.devnet.solana.com",
    getSignatureStatuses: async () => ({
      value: [
        {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: "confirmed" as const,
        },
      ],
    }),
    ...overrides,
  });

  const createMockTransaction = (): SolanaTransaction => ({
    serialize: () => new Uint8Array(32),
    feePayer: createMockPublicKey(),
    recentBlockhash: "mock_blockhash",
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockFormo = {
      trackConnectEventOnly: sandbox.stub().resolves(),
      trackDisconnectEventOnly: sandbox.stub().resolves(),
      trackChainEventOnly: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
    } as any;
  });

  afterEach(() => {
    sandbox.restore();
  });

  // -- Type Guards --

  describe("Type Guards", () => {
    it("should identify wallet context (has wallets array)", () => {
      const adapter = createMockAdapter();
      const context = createMockContext(adapter);
      expect(isSolanaWalletContext(context)).to.be.true;
      expect(isSolanaWalletAdapter(context)).to.be.false;
    });

    it("should identify wallet adapter (has name, no wallets)", () => {
      const adapter = createMockAdapter();
      expect(isSolanaWalletAdapter(adapter)).to.be.true;
      expect(isSolanaWalletContext(adapter)).to.be.false;
    });

    it("should return false for null/undefined", () => {
      expect(isSolanaWalletContext(null)).to.be.false;
      expect(isSolanaWalletAdapter(null)).to.be.false;
      expect(isSolanaWalletContext(undefined)).to.be.false;
      expect(isSolanaWalletAdapter(undefined)).to.be.false;
    });
  });

  // -- Constructor --

  describe("Constructor", () => {
    it("should initialize with default cluster (mainnet-beta)", () => {
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {});
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      handler.cleanup();
    });

    it("should use provided cluster", () => {
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        cluster: "devnet",
      });
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      handler.cleanup();
    });

    it("should not set up listeners without a wallet", () => {
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {});
      // No errors, no trackConnectEventOnly calls
      expect(mockFormo.trackConnectEventOnly.called).to.be.false;
      handler.cleanup();
    });
  });

  // -- Direct Adapter: Event Listeners --

  describe("Direct Adapter: Event Listeners", () => {
    it("should register connect/disconnect/error listeners on adapter", () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      expect(adapter._listeners.get("connect")?.size).to.be.greaterThan(0);
      expect(adapter._listeners.get("disconnect")?.size).to.be.greaterThan(0);
      expect(adapter._listeners.get("error")?.size).to.be.greaterThan(0);
      handler.cleanup();
    });

    it("should emit connect event when adapter fires connect", async () => {
      const pk = createMockPublicKey();
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });

      // Simulate adapter connect event
      adapter._emit("connect", pk);
      // Allow async handler to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.trackConnectEventOnly.calledOnce).to.be.true;
      const callArgs = mockFormo.trackConnectEventOnly.firstCall.args;
      expect(callArgs[0].address).to.equal(MOCK_ADDRESS);
      expect(callArgs[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      handler.cleanup();
    });

    it("should emit disconnect event when adapter fires disconnect", async () => {
      const pk = createMockPublicKey();
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      // First connect
      adapter._emit("connect", pk);
      await new Promise((r) => setTimeout(r, 50));

      // Then disconnect
      adapter._emit("disconnect");
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.trackDisconnectEventOnly.calledOnce).to.be.true;
      const callArgs = mockFormo.trackDisconnectEventOnly.firstCall.args;
      expect(callArgs[0]?.address).to.equal(MOCK_ADDRESS);
      handler.cleanup();
    });

    it("should skip duplicate connect events while processing", async () => {
      const pk = createMockPublicKey();
      const adapter = createMockAdapter() as any;

      // Make trackConnectEventOnly slow to test reentrancy guard
      mockFormo.trackConnectEventOnly.callsFake(
        () => new Promise((r) => setTimeout(r, 100))
      );

      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      // Fire two connect events simultaneously
      adapter._emit("connect", pk);
      adapter._emit("connect", pk);
      await new Promise((r) => setTimeout(r, 200));

      // Only one should have been processed
      expect(mockFormo.trackConnectEventOnly.callCount).to.equal(1);
      handler.cleanup();
    });

    it("should block system addresses", async () => {
      const systemPk = createMockPublicKey(
        "11111111111111111111111111111111"
      );
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", systemPk);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.trackConnectEventOnly.called).to.be.false;
      handler.cleanup();
    });
  });

  // -- Direct Adapter: Method Wrapping --

  describe("Direct Adapter: Method Wrapping", () => {
    it("should wrap sendTransaction and track STARTED/BROADCASTED events", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => "tx_sig_123",
      }) as any;
      const connection = createMockConnection();
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
        connection,
      });

      // Connect first
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Call wrapped sendTransaction
      const tx = createMockTransaction();
      const sig = await adapter.sendTransaction(tx, connection);

      expect(sig).to.equal("tx_sig_123");
      expect(mockFormo.transaction.calledTwice).to.be.true;

      // First call: STARTED
      expect(mockFormo.transaction.firstCall.args[0].status).to.equal("started");
      // Second call: BROADCASTED with signature
      expect(mockFormo.transaction.secondCall.args[0].status).to.equal("broadcasted");
      expect(mockFormo.transaction.secondCall.args[0].transactionHash).to.equal("tx_sig_123");

      handler.cleanup();
    });

    it("should track REJECTED on sendTransaction failure", async () => {
      const error = new Error("User rejected");
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => {
          throw error;
        },
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      const tx = createMockTransaction();
      try {
        await adapter.sendTransaction(tx, createMockConnection());
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).to.equal(error);
      }

      expect(mockFormo.transaction.calledTwice).to.be.true;
      expect(mockFormo.transaction.firstCall.args[0].status).to.equal("started");
      expect(mockFormo.transaction.secondCall.args[0].status).to.equal("rejected");

      handler.cleanup();
    });

    it("should wrap signMessage and track signature events", async () => {
      const mockSigBytes = new Uint8Array([1, 2, 3]);
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        signMessage: async () => mockSigBytes,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      const message = new TextEncoder().encode("Hello Solana");
      const result = await adapter.signMessage(message);

      expect(result).to.equal(mockSigBytes);
      expect(mockFormo.signature.calledTwice).to.be.true;
      expect(mockFormo.signature.firstCall.args[0].status).to.equal("requested");
      expect(mockFormo.signature.secondCall.args[0].status).to.equal("confirmed");
      expect(mockFormo.signature.secondCall.args[0].signatureHash).to.equal("010203");

      handler.cleanup();
    });

    it("should track REJECTED on signMessage failure", async () => {
      const error = new Error("Rejected");
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        signMessage: async () => {
          throw error;
        },
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      try {
        await adapter.signMessage(new Uint8Array([1]));
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).to.equal(error);
      }

      expect(mockFormo.signature.secondCall.args[0].status).to.equal("rejected");
      handler.cleanup();
    });

    it("should wrap signTransaction and track signature events", async () => {
      const signedTx = createMockTransaction();
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        signTransaction: async () => signedTx,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      const result = await adapter.signTransaction(createMockTransaction());

      expect(result).to.equal(signedTx);
      expect(mockFormo.signature.calledTwice).to.be.true;
      expect(mockFormo.signature.firstCall.args[0].status).to.equal("requested");
      expect(mockFormo.signature.firstCall.args[0].message).to.equal("[Transaction Signature]");
      expect(mockFormo.signature.secondCall.args[0].status).to.equal("confirmed");
      handler.cleanup();
    });
  });

  // -- Context Wallet: Adapter Wrapping --

  describe("Context Wallet", () => {
    it("should extract adapter from context and set up listeners", () => {
      const adapter = createMockAdapter() as any;
      const context = createMockContext(adapter);
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: context,
      });

      // Should have registered listeners on the inner adapter
      expect(adapter._listeners.get("connect")?.size).to.be.greaterThan(0);
      handler.cleanup();
    });

    it("should wrap adapter methods (not context) for tracking", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => "ctx_sig",
      }) as any;
      const context = createMockContext(adapter);
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: context,
      });

      // Connect via adapter event
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Call sendTransaction on the adapter (which context delegates to)
      const tx = createMockTransaction();
      const sig = await adapter.sendTransaction(tx, createMockConnection());

      expect(sig).to.equal("ctx_sig");
      expect(mockFormo.transaction.called).to.be.true;
      handler.cleanup();
    });

    it("should handle context with null wallet (no adapter)", () => {
      const context = createMockContext(createMockAdapter(), {
        wallet: null,
      });
      // Should not throw
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: context,
      });
      handler.cleanup();
    });
  });

  // -- Already Connected --

  describe("Already Connected Wallet", () => {
    it("should emit connect event for wallet that is already connected", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      // Allow async checkInitialConnection to run
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.trackConnectEventOnly.calledOnce).to.be.true;
      expect(mockFormo.trackConnectEventOnly.firstCall.args[0].address).to.equal(MOCK_ADDRESS);
      handler.cleanup();
    });

    it("should skip duplicate connect when setWallet is called with same connected wallet", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });
      await new Promise((r) => setTimeout(r, 50));

      // setWallet with same adapter (simulates React re-render)
      handler.setWallet(adapter);
      await new Promise((r) => setTimeout(r, 50));

      // Should only have one connect event (deduplication)
      expect(mockFormo.trackConnectEventOnly.callCount).to.equal(1);
      handler.cleanup();
    });
  });

  // -- setCluster --

  describe("setCluster", () => {
    it("should update chainId when cluster changes", () => {
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        cluster: "mainnet-beta",
      });
      expect(handler.getChainId()).to.equal(900001);

      handler.setCluster("devnet");
      expect(handler.getChainId()).to.equal(900003);
      handler.cleanup();
    });

    it("should emit chain event when connected and cluster changes", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
        cluster: "mainnet-beta",
      });
      await new Promise((r) => setTimeout(r, 50));

      handler.setCluster("devnet");

      // Allow .catch() to run
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.trackChainEventOnly.calledOnce).to.be.true;
      expect(mockFormo.trackChainEventOnly.firstCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["devnet"]
      );
      handler.cleanup();
    });

    it("should not emit chain event when not connected", () => {
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        cluster: "mainnet-beta",
      });

      handler.setCluster("devnet");

      expect(mockFormo.trackChainEventOnly.called).to.be.false;
      handler.cleanup();
    });

    it("should not emit chain event when cluster does not change", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });
      await new Promise((r) => setTimeout(r, 50));

      handler.setCluster("devnet"); // same cluster

      expect(mockFormo.trackChainEventOnly.called).to.be.false;
      handler.cleanup();
    });
  });

  // -- Autocapture Disabled --

  describe("Autocapture Disabled", () => {
    it("should not track events when autocapture is disabled", async () => {
      mockFormo.isAutocaptureEnabled.returns(false);
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => "sig",
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Connect and disconnect should not be tracked
      expect(mockFormo.trackConnectEventOnly.called).to.be.false;

      // Transaction should not be tracked (STARTED/BROADCASTED)
      const tx = createMockTransaction();
      await adapter.sendTransaction(tx, createMockConnection());
      expect(mockFormo.transaction.called).to.be.false;

      handler.cleanup();
    });
  });

  // -- Cleanup --

  describe("Cleanup", () => {
    it("should remove event listeners from adapter on cleanup", () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      const connectListeners = adapter._listeners.get("connect")?.size ?? 0;
      expect(connectListeners).to.be.greaterThan(0);

      handler.cleanup();

      // After cleanup, listeners should be removed
      expect(adapter._listeners.get("connect")?.size ?? 0).to.equal(0);
    });

    it("should restore original adapter methods on cleanup", async () => {
      const adapter = createMockAdapter({
        sendTransaction: async () => "original_result",
      }) as any;

      // Store reference to the wrapped version
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });
      const wrappedSendTx = adapter.sendTransaction;

      handler.cleanup();

      // After cleanup, sendTransaction should no longer be the wrapped version
      expect(adapter.sendTransaction).to.not.equal(wrappedSendTx);
      // And calling it should return the original result directly without tracking
      const result = await adapter.sendTransaction!(
        createMockTransaction(),
        createMockConnection()
      );
      expect(result).to.equal("original_result");
    });

    it("should cancel active polling timeouts on cleanup", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => "pending_sig",
      }) as any;
      // Connection that never confirms (always returns null)
      const connection = createMockConnection({
        getSignatureStatuses: async () => ({ value: [null] }),
      });
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
        connection,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      const tx = createMockTransaction();
      await adapter.sendTransaction(tx, connection);

      // Cleanup should cancel polling without errors
      handler.cleanup();

      // Wait to ensure no errors from stale polls
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  // -- setWallet --

  describe("setWallet", () => {
    it("should clean up previous wallet and set up new one", async () => {
      const adapter1 = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter1,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Listeners on adapter1
      expect(adapter1._listeners.get("connect")?.size).to.be.greaterThan(0);

      // Set new wallet
      const adapter2 = createMockAdapter({
        publicKey: createMockPublicKey(MOCK_ADDRESS_2),
        connected: true,
      }) as any;
      handler.setWallet(adapter2);
      await new Promise((r) => setTimeout(r, 50));

      // adapter1 should have listeners removed
      expect(adapter1._listeners.get("connect")?.size ?? 0).to.equal(0);
      // adapter2 should have listeners
      expect(adapter2._listeners.get("connect")?.size).to.be.greaterThan(0);

      handler.cleanup();
    });

    it("should handle setting wallet to null", () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapterHandler(mockFormo as any, {
        wallet: adapter,
      });

      // Should not throw
      handler.setWallet(null);
      handler.cleanup();
    });
  });

  // -- Chain ID Mapping --

  describe("Chain ID Mapping", () => {
    it("should map mainnet-beta to 900001", () => {
      expect(SOLANA_CHAIN_IDS["mainnet-beta"]).to.equal(900001);
    });

    it("should map testnet to 900002", () => {
      expect(SOLANA_CHAIN_IDS["testnet"]).to.equal(900002);
    });

    it("should map devnet to 900003", () => {
      expect(SOLANA_CHAIN_IDS["devnet"]).to.equal(900003);
    });

    it("should map localnet to 900004", () => {
      expect(SOLANA_CHAIN_IDS["localnet"]).to.equal(900004);
    });
  });

  // -- Connection API --

  describe("Connection API Support", () => {
    it("should support getSignatureStatuses (standard API)", async () => {
      const connection = createMockConnection();
      const result = await connection.getSignatureStatuses!(["test_sig"]);
      expect(result.value).to.be.an("array");
      expect(result.value[0]?.confirmationStatus).to.equal("confirmed");
    });

    it("should support getSignatureStatus (legacy API)", async () => {
      const connection = createMockConnection({
        getSignatureStatuses: undefined,
        getSignatureStatus: async () => ({
          value: {
            slot: 1,
            confirmations: 1,
            err: null,
            confirmationStatus: "confirmed" as const,
          },
        }),
      });

      const result = await connection.getSignatureStatus!("test_sig");
      expect(result.value?.confirmationStatus).to.equal("confirmed");
    });
  });

  // -- SolanaWalletEntry --

  describe("SolanaWalletEntry", () => {
    it("should have adapter and readyState", () => {
      const adapter = createMockAdapter({ name: "Phantom" });
      const entry = createMockWalletEntry(adapter);
      expect(entry.adapter.name).to.equal("Phantom");
      expect(entry.readyState).to.equal(WalletReadyState.Installed);
    });
  });
});
