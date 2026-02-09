import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import {
  SolanaWalletAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaPublicKey,
  WalletReadyState,
  SOLANA_CHAIN_IDS,
  SolanaWallet,
} from "../../src/solana/types";

describe("SolanaWalletAdapterHandler", () => {
  // Create mock objects for testing
  const createMockPublicKey = (
    address: string = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn"
  ): SolanaPublicKey => ({
    toBase58: () => address,
    toString: () => address,
    toBytes: () => new Uint8Array(32),
    equals: () => false,
  });

  const createMockAdapter = (
    overrides: Partial<SolanaWalletAdapter> = {}
  ): SolanaWalletAdapter => {
    const onStub = sinon.stub();
    const offStub = sinon.stub();
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
      on: onStub as SolanaWalletAdapter["on"],
      off: offStub as SolanaWalletAdapter["off"],
      ...overrides,
    };
  };

  const createMockWallet = (
    adapter: SolanaWalletAdapter
  ): SolanaWallet => ({
    adapter,
    readyState: adapter.readyState,
  });

  const createMockContext = (
    overrides: Partial<SolanaWalletContext> = {}
  ): SolanaWalletContext => {
    const adapter = createMockAdapter();
    return {
      autoConnect: false,
      wallets: [createMockWallet(adapter)],
      wallet: createMockWallet(adapter),
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
      value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" as const }],
    }),
    ...overrides,
  });

  describe("Type Guards", () => {
    describe("Wallet Context vs Adapter Detection", () => {
      it("should correctly identify wallet context", () => {
        const context = createMockContext();
        // Context has 'wallets' array which distinguishes it from adapter
        expect("wallets" in context).to.be.true;
        expect(Array.isArray(context.wallets)).to.be.true;
      });

      it("should correctly identify wallet adapter", () => {
        const adapter = createMockAdapter();
        // Adapter has 'name' but not 'wallets'
        expect("name" in adapter).to.be.true;
        expect("wallets" in adapter).to.be.false;
      });
    });
  });

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

  describe("Mock Objects", () => {
    it("should create valid mock public key", () => {
      const pk = createMockPublicKey();
      expect(pk.toBase58()).to.equal("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn");
    });

    it("should create valid mock adapter with events", () => {
      const adapter = createMockAdapter();
      expect(adapter.name).to.equal("Test Wallet");
      expect(typeof adapter.on).to.equal("function");
      expect(typeof adapter.off).to.equal("function");
    });

    it("should create valid mock context with wallet", () => {
      const context = createMockContext();
      expect(context.wallet).to.not.be.null;
      expect(context.wallet?.adapter.name).to.equal("Test Wallet");
    });

    it("should create valid mock connection with getSignatureStatuses", () => {
      const connection = createMockConnection();
      expect(connection.rpcEndpoint).to.equal("https://api.devnet.solana.com");
      expect(typeof connection.getSignatureStatuses).to.equal("function");
    });
  });

  describe("SolanaWallet Interface", () => {
    it("should have adapter and readyState properties", () => {
      const adapter = createMockAdapter();
      const wallet = createMockWallet(adapter);

      expect(wallet.adapter).to.equal(adapter);
      expect(wallet.readyState).to.equal(WalletReadyState.Installed);
    });

    it("should access adapter name through wallet.adapter.name", () => {
      const adapter = createMockAdapter({ name: "Phantom" });
      const wallet = createMockWallet(adapter);

      expect(wallet.adapter.name).to.equal("Phantom");
    });
  });

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
          value: { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" as const },
        }),
      });

      const result = await connection.getSignatureStatus!("test_sig");
      expect(result.value?.confirmationStatus).to.equal("confirmed");
    });
  });
});
