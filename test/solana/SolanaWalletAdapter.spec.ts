import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import { SolanaWalletAdapter } from "../../src/solana/SolanaWalletAdapter";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import {
  ISolanaWalletAdapter,
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

describe("SolanaWalletAdapter", () => {
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
    overrides: Partial<ISolanaWalletAdapter> = {}
  ): ISolanaWalletAdapter => {
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
      }) as ISolanaWalletAdapter["on"],
      off: ((event: string, listener: Function) => {
        listeners.get(event)?.delete(listener);
      }) as ISolanaWalletAdapter["off"],
      // Helper to emit events in tests
      _emit: (event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach((fn) => fn(...args));
      },
      _listeners: listeners,
      ...overrides,
    } as ISolanaWalletAdapter & {
      _emit: (event: string, ...args: unknown[]) => void;
      _listeners: Map<string, Set<Function>>;
    };
  };

  const createMockWalletEntry = (
    adapter: ISolanaWalletAdapter
  ): SolanaWalletEntry => ({
    adapter,
    readyState: adapter.readyState,
  });

  const createMockContext = (
    adapter: ISolanaWalletAdapter,
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {});
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      handler.cleanup();
    });

    it("should use provided cluster", () => {
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        cluster: "devnet",
      });
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      handler.cleanup();
    });

    it("should not set up listeners without a wallet", () => {
      const handler = new SolanaWalletAdapter(mockFormo as any, {});
      // No errors, no connect calls
      expect(mockFormo.connect.called).to.be.false;
      handler.cleanup();
    });
  });

  // -- Direct Adapter: Event Listeners --

  describe("Direct Adapter: Event Listeners", () => {
    it("should register connect/disconnect/error listeners on adapter", () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });

      // Simulate adapter connect event
      adapter._emit("connect", pk);
      // Allow async handler to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.connect.calledOnce).to.be.true;
      const callArgs = mockFormo.connect.firstCall.args;
      expect(callArgs[0].address).to.equal(MOCK_ADDRESS);
      expect(callArgs[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      handler.cleanup();
    });

    it("should emit disconnect event when adapter fires disconnect", async () => {
      const pk = createMockPublicKey();
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // First connect
      adapter._emit("connect", pk);
      await new Promise((r) => setTimeout(r, 50));

      // Then disconnect
      adapter._emit("disconnect");
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      const callArgs = mockFormo.disconnect.firstCall.args;
      expect(callArgs[0]?.address).to.equal(MOCK_ADDRESS);
      handler.cleanup();
    });

    it("should skip duplicate connect events while processing", async () => {
      const pk = createMockPublicKey();
      const adapter = createMockAdapter() as any;

      // Make connect slow to test reentrancy guard
      mockFormo.connect.callsFake(
        () => new Promise((r) => setTimeout(r, 100))
      );

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Fire two connect events simultaneously
      adapter._emit("connect", pk);
      adapter._emit("connect", pk);
      await new Promise((r) => setTimeout(r, 200));

      // Only one should have been processed
      expect(mockFormo.connect.callCount).to.equal(1);
      handler.cleanup();
    });

    it("should block system addresses", async () => {
      const systemPk = createMockPublicKey(
        "11111111111111111111111111111111"
      );
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", systemPk);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.connect.called).to.be.false;
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Allow async checkInitialConnection to run
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].address).to.equal(MOCK_ADDRESS);
      handler.cleanup();
    });

    it("should skip duplicate connect when setWallet is called with same connected wallet", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });
      await new Promise((r) => setTimeout(r, 50));

      // setWallet with same adapter (simulates React re-render)
      handler.setWallet(adapter);
      await new Promise((r) => setTimeout(r, 50));

      // Should only have one connect event (deduplication)
      expect(mockFormo.connect.callCount).to.equal(1);
      handler.cleanup();
    });
  });

  // -- setCluster --

  describe("setCluster", () => {
    it("should update chainId when cluster changes", () => {
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "mainnet-beta",
      });
      await new Promise((r) => setTimeout(r, 50));

      handler.setCluster("devnet");

      // Allow .catch() to run
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.chain.calledOnce).to.be.true;
      expect(mockFormo.chain.firstCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["devnet"]
      );
      handler.cleanup();
    });

    it("should not emit chain event when not connected", () => {
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        cluster: "mainnet-beta",
      });

      handler.setCluster("devnet");

      expect(mockFormo.chain.called).to.be.false;
      handler.cleanup();
    });

    it("should not emit chain event when cluster does not change", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });
      await new Promise((r) => setTimeout(r, 50));

      handler.setCluster("devnet"); // same cluster

      expect(mockFormo.chain.called).to.be.false;
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Connect and disconnect should not be tracked
      expect(mockFormo.connect.called).to.be.false;

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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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
      const handler = new SolanaWalletAdapter(mockFormo as any, {
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

  // -- Wallet Swap Detection --

  describe("Wallet Swap Detection", () => {
    it("should detect adapter change in context and rebind listeners", async () => {
      const adapter1 = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const context = createMockContext(adapter1) as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: context,
      });

      // Connect with adapter1
      adapter1._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFormo.connect.calledOnce).to.be.true;

      // Switch to adapter2 (simulate wallet swap)
      const adapter2 = createMockAdapter({
        publicKey: createMockPublicKey(MOCK_ADDRESS_2),
        connected: true,
      }) as any;
      context.wallet = createMockWalletEntry(adapter2);
      context.publicKey = createMockPublicKey(MOCK_ADDRESS_2);

      // Call syncWalletState to detect the change
      handler.syncWalletState();
      await new Promise((r) => setTimeout(r, 50));

      // adapter2 should now have listeners
      expect(adapter2._listeners.get("connect")?.size).to.be.greaterThan(0);

      handler.cleanup();
    });

    it("should handle adapter becoming null in context", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const context = createMockContext(adapter) as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: context,
      });

      // Connect first
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Remove wallet from context (all wallets disconnected)
      context.wallet = null;

      // Sync should handle this gracefully
      handler.syncWalletState();
      await new Promise((r) => setTimeout(r, 50));

      // Should emit disconnect
      expect(mockFormo.disconnect.called).to.be.true;

      handler.cleanup();
    });

    it("should be a no-op for non-context wallets", async () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Should not throw for direct adapter
      handler.syncWalletState();

      handler.cleanup();
    });
  });

  // -- Disconnect Guards --

  describe("Disconnect Guards", () => {
    it("should not emit disconnect when no prior connection exists", async () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Emit disconnect without ever connecting
      adapter._emit("disconnect");
      await new Promise((r) => setTimeout(r, 50));

      // Should not emit disconnect event
      expect(mockFormo.disconnect.called).to.be.false;

      handler.cleanup();
    });

    it("should emit disconnect only when prior connection exists", async () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Connect first
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Then disconnect
      adapter._emit("disconnect");
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.disconnect.calledOnce).to.be.true;

      handler.cleanup();
    });
  });

  // -- Double-Wrapping Prevention --

  describe("Double-Wrapping Prevention", () => {
    it("should not double-wrap the same adapter on setWallet", async () => {
      const originalSendTransaction = async () => "original_result";
      const adapter = createMockAdapter({
        sendTransaction: originalSendTransaction,
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Connect and do a transaction
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      await adapter.sendTransaction(createMockTransaction(), createMockConnection());
      const callCountAfterFirst = mockFormo.transaction.callCount;

      // Setting the same wallet again should restore and re-wrap cleanly
      handler.setWallet(adapter);

      // Re-connect after setWallet
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Second transaction should emit correct number of events (not doubled)
      await adapter.sendTransaction(createMockTransaction(), createMockConnection());

      // Should have added the same number of calls (STARTED + BROADCASTED)
      const callsForSecondTx = mockFormo.transaction.callCount - callCountAfterFirst;
      expect(callsForSecondTx).to.equal(2); // STARTED + BROADCASTED, not 4

      handler.cleanup();
    });

    it("should properly re-wrap when switching to different adapter", async () => {
      const adapter1 = createMockAdapter({
        sendTransaction: async () => "result1",
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter1,
      });

      adapter1._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      const adapter2 = createMockAdapter({
        sendTransaction: async () => "result2",
        publicKey: createMockPublicKey(MOCK_ADDRESS_2),
        connected: true,
      }) as any;

      handler.setWallet(adapter2);
      adapter2._emit("connect", createMockPublicKey(MOCK_ADDRESS_2));
      await new Promise((r) => setTimeout(r, 50));

      const result = await adapter2.sendTransaction(
        createMockTransaction(),
        createMockConnection()
      );
      expect(result).to.equal("result2");

      handler.cleanup();
    });
  });

  // -- ChainId Consistency --

  describe("ChainId Consistency", () => {
    it("should use captured chainId for all events in transaction lifecycle", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => "tx_sig",
      }) as any;

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "mainnet-beta",
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Call sendTransaction
      await adapter.sendTransaction(createMockTransaction(), createMockConnection());

      // Both STARTED and BROADCASTED should have mainnet-beta chainId
      expect(mockFormo.transaction.firstCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["mainnet-beta"]
      );
      expect(mockFormo.transaction.secondCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["mainnet-beta"]
      );

      handler.cleanup();
    });

    it("should use captured chainId even if setCluster called during transaction", async () => {
      let clusterChangeCallback: (() => void) | null = null;

      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => {
          // Simulate setCluster being called while waiting for approval
          if (clusterChangeCallback) clusterChangeCallback();
          return "tx_sig";
        },
      }) as any;

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "mainnet-beta",
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Set up callback to change cluster mid-transaction
      clusterChangeCallback = () => {
        handler.setCluster("devnet");
      };

      await adapter.sendTransaction(createMockTransaction(), createMockConnection());

      // STARTED should be mainnet-beta (captured before the call)
      expect(mockFormo.transaction.firstCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["mainnet-beta"]
      );
      // BROADCASTED should also be mainnet-beta (captured at call time)
      expect(mockFormo.transaction.secondCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["mainnet-beta"]
      );

      handler.cleanup();
    });
  });

  // -- Method Re-wrapping (StandardWalletAdapter compatibility) --

  describe("Method Re-wrapping", () => {
    it("should re-wrap signMessage after external overwrite (e.g. StandardWalletAdapter._reset)", async () => {
      const originalSignMessage = async (_msg: Uint8Array) => new Uint8Array(64);
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        signMessage: originalSignMessage,
        sendTransaction: async () => "sig",
      }) as any;

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });

      // Wait for initial connection
      await new Promise((r) => setTimeout(r, 50));

      // Simulate StandardWalletAdapter._reset() overwriting signMessage
      const newOriginal = async (_msg: Uint8Array) => new Uint8Array(64);
      adapter.signMessage = newOriginal;

      // Trigger re-wrap via connect event (which calls rewrapOverwrittenMethods)
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Now call signMessage — should go through our wrapper and emit events
      mockFormo.signature.resetHistory();
      await adapter.signMessage(new Uint8Array([1, 2, 3]));

      expect(mockFormo.signature.called).to.be.true;
      handler.cleanup();
    });

    it("should wrap signMessage that appears after initial setup (StandardWalletAdapter._reset)", async () => {
      // At init time, adapter has no signMessage (StandardWalletAdapter sets it lazily)
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: async () => "sig",
      }) as any;
      // Explicitly ensure no signMessage at wrap time
      delete adapter.signMessage;

      const handler = new SolanaWalletAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });

      await new Promise((r) => setTimeout(r, 50));

      // Simulate _reset() adding signMessage after connect
      adapter.signMessage = async (_msg: Uint8Array) => new Uint8Array(64);

      // Trigger re-wrap
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      mockFormo.signature.resetHistory();
      await adapter.signMessage(new Uint8Array([1, 2, 3]));

      expect(mockFormo.signature.called).to.be.true;
      handler.cleanup();
    });
  });

  // -- System Address Blocking --

  describe("System Address Blocking", () => {
    const SYSTEM_ADDRESSES = [
      { name: "System Program", address: "11111111111111111111111111111111" },
      { name: "Token Program", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      { name: "Token 2022 Program", address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
      { name: "Associated Token Program", address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
      { name: "Rent Sysvar", address: "SysvarRent111111111111111111111111111111111" },
      { name: "Clock Sysvar", address: "SysvarC1ock11111111111111111111111111111111" },
    ];

    SYSTEM_ADDRESSES.forEach(({ name, address }) => {
      it(`should block ${name} address`, async () => {
        const systemPk = createMockPublicKey(address);
        const adapter = createMockAdapter() as any;
        const handler = new SolanaWalletAdapter(mockFormo as any, {
          wallet: adapter,
        });

        adapter._emit("connect", systemPk);
        await new Promise((r) => setTimeout(r, 50));

        expect(mockFormo.connect.called).to.be.false;
        handler.cleanup();
      });
    });
  });
});
