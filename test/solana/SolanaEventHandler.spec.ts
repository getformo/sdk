import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { SolanaEventHandler } from "../../src/solana/SolanaEventHandler";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import {
  SolanaWalletAdapter,
  SolanaCluster,
  SOLANA_CHAIN_IDS,
} from "../../src/solana/types";

describe("SolanaEventHandler", () => {
  let sandbox: sinon.SinonSandbox;
  let mockFormo: sinon.SinonStubbedInstance<FormoAnalytics>;
  let mockWallet: SolanaWalletAdapter;

  const mockAddress = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
  const mockCluster: SolanaCluster = "mainnet-beta";

  const createMockWallet = (
    overrides: Partial<SolanaWalletAdapter> = {}
  ): SolanaWalletAdapter => ({
    publicKey: null,
    connected: false,
    connecting: false,
    disconnecting: false,
    wallet: {
      adapter: {
        name: "Phantom",
        icon: "https://phantom.app/icon.png",
      },
    },
    signMessage: undefined,
    signTransaction: undefined,
    sendTransaction: undefined,
    ...overrides,
  });

  const createConnectedWallet = (
    address: string = mockAddress
  ): SolanaWalletAdapter =>
    createMockWallet({
      publicKey: { toBase58: () => address },
      connected: true,
    });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    // Create mock FormoAnalytics
    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      detect: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
    } as any;

    // Create default mock wallet
    mockWallet = createMockWallet();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("constructor", () => {
    it("should initialize with correct cluster", () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        "devnet"
      );

      expect(handler.getCluster()).to.equal("devnet");
      handler.cleanup();
    });

    it("should default to mainnet-beta cluster", () => {
      const handler = new SolanaEventHandler(mockFormo as any, mockWallet);

      expect(handler.getCluster()).to.equal("mainnet-beta");
      handler.cleanup();
    });

    it("should detect wallet on initialization", async () => {
      new SolanaEventHandler(mockFormo as any, mockWallet, mockCluster);

      // Wait for async initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockFormo.detect.calledOnce).to.be.true;
      expect(mockFormo.detect.firstCall.args[0]).to.deep.include({
        providerName: "Phantom",
        rdns: "app.phantom.solana",
      });
    });

    it("should emit connect event if wallet is already connected", async () => {
      mockWallet = createConnectedWallet();

      new SolanaEventHandler(mockFormo as any, mockWallet, mockCluster);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0]).to.deep.include({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
        address: mockAddress,
      });
    });
  });

  describe("connection events", () => {
    it("should track connect event when wallet connects", async () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      // Simulate wallet connecting
      mockWallet.publicKey = { toBase58: () => mockAddress };
      mockWallet.connected = true;

      // Wait for polling to detect the change
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mockFormo.connect.calledOnce).to.be.true;
      const connectCall = mockFormo.connect.firstCall;
      expect(connectCall.args[0]).to.deep.include({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
        address: mockAddress,
      });
      expect(connectCall.args[1]).to.deep.include({
        blockchain: "solana",
        cluster: "mainnet-beta",
      });

      handler.cleanup();
    });

    it("should track disconnect event when wallet disconnects", async () => {
      // Start with connected wallet
      mockWallet = createConnectedWallet();

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      // Wait for initial connect
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reset stubs to check disconnect
      mockFormo.connect.reset();
      mockFormo.disconnect.reset();

      // Simulate wallet disconnecting
      mockWallet.publicKey = null;
      mockWallet.connected = false;

      // Wait for polling to detect the change
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mockFormo.disconnect.calledOnce).to.be.true;
      expect(mockFormo.disconnect.firstCall.args[1]).to.deep.include({
        blockchain: "solana",
        cluster: "mainnet-beta",
      });

      handler.cleanup();
    });

    it("should not track connect when autocapture is disabled", async () => {
      mockFormo.isAutocaptureEnabled.withArgs("connect").returns(false);

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      // Simulate wallet connecting
      mockWallet.publicKey = { toBase58: () => mockAddress };
      mockWallet.connected = true;

      // Wait for polling
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mockFormo.connect.called).to.be.false;

      handler.cleanup();
    });
  });

  describe("cluster/chain events", () => {
    it("should emit chain event when cluster is updated", async () => {
      mockWallet = createConnectedWallet();

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        "mainnet-beta"
      );

      // Wait for initial connect
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update cluster
      handler.updateCluster("devnet");

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFormo.chain.calledOnce).to.be.true;
      expect(mockFormo.chain.firstCall.args[0]).to.deep.include({
        chainId: SOLANA_CHAIN_IDS["devnet"],
        address: mockAddress,
      });

      handler.cleanup();
    });

    it("should not emit chain event when not connected", async () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        "mainnet-beta"
      );

      // Update cluster without being connected
      handler.updateCluster("devnet");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFormo.chain.called).to.be.false;

      handler.cleanup();
    });

    it("should not emit chain event when cluster is the same", async () => {
      mockWallet = createConnectedWallet();

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        "mainnet-beta"
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update to same cluster
      handler.updateCluster("mainnet-beta");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFormo.chain.called).to.be.false;

      handler.cleanup();
    });
  });

  describe("signature events", () => {
    it("should wrap signMessage and track signature events", async () => {
      mockWallet = createConnectedWallet();
      const originalSignMessage = sandbox
        .stub()
        .resolves(new Uint8Array([1, 2, 3]));
      mockWallet.signMessage = originalSignMessage;

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call signMessage
      const message = new TextEncoder().encode("Hello Solana");
      await mockWallet.signMessage!(message);

      expect(mockFormo.signature.calledTwice).to.be.true;

      // First call should be "requested"
      expect(mockFormo.signature.firstCall.args[0].status).to.equal(
        "requested"
      );

      // Second call should be "confirmed"
      expect(mockFormo.signature.secondCall.args[0].status).to.equal(
        "confirmed"
      );
      expect(mockFormo.signature.secondCall.args[0].message).to.equal(
        "Hello Solana"
      );

      handler.cleanup();
    });

    it("should track rejected signature on error", async () => {
      mockWallet = createConnectedWallet();
      const originalSignMessage = sandbox
        .stub()
        .rejects(new Error("User rejected"));
      mockWallet.signMessage = originalSignMessage;

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call signMessage and expect it to throw
      const message = new TextEncoder().encode("Hello");
      try {
        await mockWallet.signMessage!(message);
      } catch (e) {
        // Expected
      }

      expect(mockFormo.signature.calledTwice).to.be.true;
      expect(mockFormo.signature.secondCall.args[0].status).to.equal(
        "rejected"
      );

      handler.cleanup();
    });

    it("should not track signature when autocapture is disabled", async () => {
      mockFormo.isAutocaptureEnabled.withArgs("signature").returns(false);

      mockWallet = createConnectedWallet();
      const originalSignMessage = sandbox
        .stub()
        .resolves(new Uint8Array([1, 2, 3]));
      mockWallet.signMessage = originalSignMessage;

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const message = new TextEncoder().encode("Hello");
      await mockWallet.signMessage!(message);

      expect(mockFormo.signature.called).to.be.false;

      handler.cleanup();
    });
  });

  describe("transaction events", () => {
    it("should wrap sendTransaction and track transaction events", async () => {
      mockWallet = createConnectedWallet();
      const mockTxSignature = "5wHs3...txsig";
      const originalSendTransaction = sandbox.stub().resolves(mockTxSignature);
      mockWallet.sendTransaction = originalSendTransaction;

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call sendTransaction
      const result = await mockWallet.sendTransaction!(
        {} as any,
        {} as any,
        {}
      );

      expect(result).to.equal(mockTxSignature);
      expect(mockFormo.transaction.calledTwice).to.be.true;

      // First call should be "started"
      expect(mockFormo.transaction.firstCall.args[0].status).to.equal(
        "started"
      );

      // Second call should be "broadcasted"
      expect(mockFormo.transaction.secondCall.args[0].status).to.equal(
        "broadcasted"
      );
      expect(mockFormo.transaction.secondCall.args[0].transactionHash).to.equal(
        mockTxSignature
      );

      handler.cleanup();
    });

    it("should track rejected transaction on error", async () => {
      mockWallet = createConnectedWallet();
      const originalSendTransaction = sandbox
        .stub()
        .rejects(new Error("Transaction failed"));
      mockWallet.sendTransaction = originalSendTransaction;

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        await mockWallet.sendTransaction!({} as any, {} as any, {});
      } catch (e) {
        // Expected
      }

      expect(mockFormo.transaction.calledTwice).to.be.true;
      expect(mockFormo.transaction.secondCall.args[0].status).to.equal(
        "rejected"
      );

      handler.cleanup();
    });
  });

  describe("manual tracking", () => {
    it("should allow manual signature tracking", async () => {
      mockWallet = createConnectedWallet();

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      await handler.trackSignature({
        status: "confirmed" as any,
        message: "Manual signature",
        signatureHash: "0xsig123",
      });

      expect(mockFormo.signature.called).to.be.true;
      expect(mockFormo.signature.lastCall.args[0]).to.deep.include({
        status: "confirmed",
        message: "Manual signature",
        signatureHash: "0xsig123",
      });

      handler.cleanup();
    });

    it("should allow manual transaction tracking", async () => {
      mockWallet = createConnectedWallet();

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      await handler.trackTransaction({
        status: "broadcasted" as any,
        transactionHash: "5wHs3...txsig",
        to: "recipient123",
        value: "1000000",
      });

      expect(mockFormo.transaction.called).to.be.true;
      expect(mockFormo.transaction.lastCall.args[0]).to.deep.include({
        status: "broadcasted",
        transactionHash: "5wHs3...txsig",
      });

      handler.cleanup();
    });

    it("should not track manually when wallet is not connected", async () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await handler.trackSignature({
        status: "confirmed" as any,
        message: "Test",
      });

      // Only detect should be called, not signature
      expect(mockFormo.signature.called).to.be.false;

      handler.cleanup();
    });
  });

  describe("getters", () => {
    it("should return connected address", () => {
      mockWallet = createConnectedWallet();

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      expect(handler.getConnectedAddress()).to.equal(mockAddress);
      handler.cleanup();
    });

    it("should return undefined when not connected", () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      expect(handler.getConnectedAddress()).to.be.undefined;
      handler.cleanup();
    });

    it("should return connection status", () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      expect(handler.isConnected()).to.be.false;

      mockWallet.connected = true;
      expect(handler.isConnected()).to.be.true;

      handler.cleanup();
    });
  });

  describe("cleanup", () => {
    it("should stop polling on cleanup", async () => {
      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      // Wait a bit then cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      handler.cleanup();

      // Reset stub counts
      mockFormo.connect.reset();

      // Simulate wallet connecting after cleanup
      mockWallet.publicKey = { toBase58: () => mockAddress };
      mockWallet.connected = true;

      // Wait for what would be a poll
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Should not track events after cleanup
      expect(mockFormo.connect.called).to.be.false;
    });

    it("should restore original wallet methods on cleanup", async () => {
      mockWallet = createConnectedWallet();
      const originalSignMessage = sandbox
        .stub()
        .resolves(new Uint8Array([1, 2, 3]));
      mockWallet.signMessage = originalSignMessage;

      const handler = new SolanaEventHandler(
        mockFormo as any,
        mockWallet,
        mockCluster
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reset signature stubs to verify no tracking after cleanup
      mockFormo.signature.reset();

      handler.cleanup();

      // After cleanup, calling signMessage should work but not trigger tracking
      const message = new TextEncoder().encode("Test after cleanup");
      await mockWallet.signMessage!(message);

      // Original function should have been called
      expect(originalSignMessage.calledOnce).to.be.true;

      // But no tracking should happen (method was restored)
      expect(mockFormo.signature.called).to.be.false;
    });
  });

  describe("SOLANA_CHAIN_IDS", () => {
    it("should have correct chain IDs for all clusters", () => {
      expect(SOLANA_CHAIN_IDS["mainnet-beta"]).to.equal(101);
      expect(SOLANA_CHAIN_IDS["devnet"]).to.equal(102);
      expect(SOLANA_CHAIN_IDS["testnet"]).to.equal(103);
      expect(SOLANA_CHAIN_IDS["localnet"]).to.equal(104);
    });
  });
});
