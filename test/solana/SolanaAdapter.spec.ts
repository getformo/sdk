import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import { SolanaAdapter } from "../../src/solana/SolanaAdapter";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import {
  ISolanaAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaPublicKey,
  SolanaTransaction,
  WalletReadyState,
  SOLANA_CHAIN_IDS,
  SolanaWalletEntry,
  isSolanaWalletContext,
  isSolanaAdapter,
} from "../../src/solana/types";

describe("SolanaAdapter", () => {
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
    overrides: Partial<ISolanaAdapter> = {}
  ): ISolanaAdapter => {
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
      }) as ISolanaAdapter["on"],
      off: ((event: string, listener: Function) => {
        listeners.get(event)?.delete(listener);
      }) as ISolanaAdapter["off"],
      // Helper to emit events in tests
      _emit: (event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach((fn) => fn(...args));
      },
      _listeners: listeners,
      ...overrides,
    } as ISolanaAdapter & {
      _emit: (event: string, ...args: unknown[]) => void;
      _listeners: Map<string, Set<Function>>;
    };
  };

  const createMockWalletEntry = (
    adapter: ISolanaAdapter
  ): SolanaWalletEntry => ({
    adapter,
    readyState: adapter.readyState,
  });

  const createMockContext = (
    adapter: ISolanaAdapter,
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
      expect(isSolanaAdapter(context)).to.be.false;
    });

    it("should identify wallet adapter (has name, no wallets)", () => {
      const adapter = createMockAdapter();
      expect(isSolanaAdapter(adapter)).to.be.true;
      expect(isSolanaWalletContext(adapter)).to.be.false;
    });

    it("should return false for null/undefined", () => {
      expect(isSolanaWalletContext(null)).to.be.false;
      expect(isSolanaAdapter(null)).to.be.false;
      expect(isSolanaWalletContext(undefined)).to.be.false;
      expect(isSolanaAdapter(undefined)).to.be.false;
    });
  });

  // -- Constructor --

  describe("Constructor", () => {
    it("should initialize with default cluster (mainnet-beta)", () => {
      const handler = new SolanaAdapter(mockFormo as any, {});
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      handler.cleanup();
    });

    it("should use provided cluster", () => {
      const handler = new SolanaAdapter(mockFormo as any, {
        cluster: "devnet",
      });
      expect(handler.getChainId()).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      handler.cleanup();
    });

    it("should not set up listeners without a wallet", () => {
      const handler = new SolanaAdapter(mockFormo as any, {});
      // No errors, no connect calls
      expect(mockFormo.connect.called).to.be.false;
      handler.cleanup();
    });
  });

  // -- Direct Adapter: Event Listeners --

  describe("Direct Adapter: Event Listeners", () => {
    it("should register connect/disconnect/error listeners on adapter", () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      expect(adapter._listeners.get("connect")?.size).to.be.greaterThan(0);
      expect(adapter._listeners.get("disconnect")?.size).to.be.greaterThan(0);
      expect(adapter._listeners.get("error")?.size).to.be.greaterThan(0);
      handler.cleanup();
    });

    it("should NOT modify adapter methods (no wrapping)", () => {
      const originalSendTransaction = async () => "original_result";
      const originalSignMessage = async () => new Uint8Array(64);
      const adapter = createMockAdapter({
        sendTransaction: originalSendTransaction,
        signMessage: originalSignMessage,
      }) as any;

      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Adapter methods should remain untouched
      expect(adapter.sendTransaction).to.equal(originalSendTransaction);
      expect(adapter.signMessage).to.equal(originalSignMessage);
      handler.cleanup();
    });

    it("should emit connect event when adapter fires connect", async () => {
      const pk = createMockPublicKey();
      const adapter = createMockAdapter() as any;
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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

      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", systemPk);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFormo.connect.called).to.be.false;
      handler.cleanup();
    });
  });

  // -- Explicit Transaction Tracking --

  describe("Explicit Transaction Tracking", () => {
    it("should emit BROADCASTED event on trackTransaction", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "devnet",
      });

      // Connect first to set up address
      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackTransaction("tx_sig_123");

      expect(mockFormo.transaction.calledOnce).to.be.true;
      expect(mockFormo.transaction.firstCall.args[0].status).to.equal("broadcasted");
      expect(mockFormo.transaction.firstCall.args[0].transactionHash).to.equal("tx_sig_123");
      expect(mockFormo.transaction.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);

      handler.cleanup();
    });

    it("should poll for confirmation after trackTransaction", async function () {
      this.timeout(5000);
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const connection = createMockConnection();
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
        connection,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackTransaction("tx_sig_123");

      // Wait for polling to complete (poll interval is 2s)
      await new Promise((r) => setTimeout(r, 3000));

      // Should have BROADCASTED + CONFIRMED
      expect(mockFormo.transaction.callCount).to.be.greaterThanOrEqual(2);
      const lastCall = mockFormo.transaction.lastCall.args[0];
      expect(lastCall.status).to.equal("confirmed");
      expect(lastCall.transactionHash).to.equal("tx_sig_123");

      handler.cleanup();
    });

    it("should track REVERTED transactions", async function () {
      this.timeout(5000);
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const connection = createMockConnection({
        getSignatureStatuses: async () => ({
          value: [
            {
              slot: 1,
              confirmations: 1,
              err: { InstructionError: [0, "Custom"] },
              confirmationStatus: "confirmed" as const,
            },
          ],
        }),
      });
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
        connection,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackTransaction("tx_sig_fail");

      // Wait for polling (poll interval is 2s)
      await new Promise((r) => setTimeout(r, 3000));

      const lastCall = mockFormo.transaction.lastCall.args[0];
      expect(lastCall.status).to.equal("reverted");

      handler.cleanup();
    });

    it("should emit STARTED and REJECTED via trackTransactionStatus", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackTransactionStatus("started");
      handler.trackTransactionStatus("rejected");

      expect(mockFormo.transaction.calledTwice).to.be.true;
      expect(mockFormo.transaction.firstCall.args[0].status).to.equal("started");
      expect(mockFormo.transaction.secondCall.args[0].status).to.equal("rejected");

      handler.cleanup();
    });
  });

  // -- Explicit Signature Tracking --

  describe("Explicit Signature Tracking", () => {
    it("should track signature events via trackSignature", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackSignature("requested", { message: "Hello Solana" });
      handler.trackSignature("confirmed", { message: "Hello Solana", signatureHash: "abcdef" });

      expect(mockFormo.signature.calledTwice).to.be.true;
      expect(mockFormo.signature.firstCall.args[0].status).to.equal("requested");
      expect(mockFormo.signature.firstCall.args[0].message).to.equal("Hello Solana");
      expect(mockFormo.signature.secondCall.args[0].status).to.equal("confirmed");
      expect(mockFormo.signature.secondCall.args[0].signatureHash).to.equal("abcdef");

      handler.cleanup();
    });

    it("should track REJECTED signature", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackSignature("requested", { message: "Sign this" });
      handler.trackSignature("rejected", { message: "Sign this" });

      expect(mockFormo.signature.secondCall.args[0].status).to.equal("rejected");
      handler.cleanup();
    });
  });

  // -- Explicit Connect/Disconnect Tracking --

  describe("Explicit Connect/Disconnect Tracking", () => {
    it("should track connection via trackConnect", () => {
      const handler = new SolanaAdapter(mockFormo as any, {
        cluster: "devnet",
      });

      handler.trackConnect(MOCK_ADDRESS, { walletName: "Phantom" });

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].address).to.equal(MOCK_ADDRESS);
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      expect(mockFormo.connect.firstCall.args[1]!.providerName).to.equal("Phantom");

      handler.cleanup();
    });

    it("should track disconnection via trackDisconnect", () => {
      const handler = new SolanaAdapter(mockFormo as any, {});

      // Connect first
      handler.trackConnect(MOCK_ADDRESS);

      // Then disconnect
      handler.trackDisconnect();

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.firstCall.args[0]!.address).to.equal(MOCK_ADDRESS);

      handler.cleanup();
    });

    it("should skip trackDisconnect when no prior connection", () => {
      const handler = new SolanaAdapter(mockFormo as any, {});

      handler.trackDisconnect();

      expect(mockFormo.disconnect.called).to.be.false;

      handler.cleanup();
    });

    it("should deduplicate trackConnect for same address", () => {
      const handler = new SolanaAdapter(mockFormo as any, {});

      handler.trackConnect(MOCK_ADDRESS);
      handler.trackConnect(MOCK_ADDRESS); // duplicate

      expect(mockFormo.connect.calledOnce).to.be.true;

      handler.cleanup();
    });

    it("should block system addresses in trackConnect", () => {
      const handler = new SolanaAdapter(mockFormo as any, {});

      handler.trackConnect("11111111111111111111111111111111");

      expect(mockFormo.connect.called).to.be.false;

      handler.cleanup();
    });
  });

  // -- Context Wallet --

  describe("Context Wallet", () => {
    it("should extract adapter from context and set up listeners", () => {
      const adapter = createMockAdapter() as any;
      const context = createMockContext(adapter);
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: context,
      });

      // Should have registered listeners on the inner adapter
      expect(adapter._listeners.get("connect")?.size).to.be.greaterThan(0);
      handler.cleanup();
    });

    it("should NOT modify adapter methods in context mode", () => {
      const originalSendTransaction = async () => "ctx_sig";
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
        sendTransaction: originalSendTransaction,
      }) as any;
      const context = createMockContext(adapter);
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: context,
      });

      // Adapter methods should remain untouched
      expect(adapter.sendTransaction).to.equal(originalSendTransaction);
      handler.cleanup();
    });

    it("should handle context with null wallet (no adapter)", () => {
      const context = createMockContext(createMockAdapter(), {
        wallet: null,
      });
      // Should not throw
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      }) as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      // Connect should not be tracked
      expect(mockFormo.connect.called).to.be.false;

      // Explicit tracking should also respect autocapture
      handler.trackTransaction("tx_sig");
      expect(mockFormo.transaction.called).to.be.false;

      handler.trackSignature("requested", { message: "test" });
      expect(mockFormo.signature.called).to.be.false;

      handler.cleanup();
    });
  });

  // -- Cleanup --

  describe("Cleanup", () => {
    it("should remove event listeners from adapter on cleanup", () => {
      const adapter = createMockAdapter() as any;
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      const connectListeners = adapter._listeners.get("connect")?.size ?? 0;
      expect(connectListeners).to.be.greaterThan(0);

      handler.cleanup();

      // After cleanup, listeners should be removed
      expect(adapter._listeners.get("connect")?.size ?? 0).to.equal(0);
    });

    it("should NOT modify adapter methods on cleanup (nothing to restore)", () => {
      const originalSendTransaction = async () => "original_result";
      const adapter = createMockAdapter({
        sendTransaction: originalSendTransaction,
      }) as any;

      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
      });

      // Method should still be the original
      expect(adapter.sendTransaction).to.equal(originalSendTransaction);

      handler.cleanup();

      // Should still be the original after cleanup
      expect(adapter.sendTransaction).to.equal(originalSendTransaction);
    });

    it("should cancel active polling timeouts on cleanup", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;
      // Connection that never confirms (always returns null)
      const connection = createMockConnection({
        getSignatureStatuses: async () => ({ value: [null] }),
      });
      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
        connection,
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackTransaction("pending_sig");

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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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
      const handler = new SolanaAdapter(mockFormo as any, {
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

  // -- ChainId Consistency --

  describe("ChainId Consistency", () => {
    it("should use current chainId for trackTransaction", async () => {
      const adapter = createMockAdapter({
        publicKey: createMockPublicKey(),
        connected: true,
      }) as any;

      const handler = new SolanaAdapter(mockFormo as any, {
        wallet: adapter,
        cluster: "mainnet-beta",
      });

      adapter._emit("connect", createMockPublicKey());
      await new Promise((r) => setTimeout(r, 50));

      handler.trackTransaction("tx_sig");

      expect(mockFormo.transaction.firstCall.args[0].chainId).to.equal(
        SOLANA_CHAIN_IDS["mainnet-beta"]
      );

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
        const handler = new SolanaAdapter(mockFormo as any, {
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
