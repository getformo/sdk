import { expect } from "chai";
import { describe, it } from "mocha";
import {
  SOLANA_CHAIN_IDS,
  SOLANA_CLUSTERS_BY_ID,
  DEFAULT_SOLANA_CHAIN_ID,
  isSolanaWalletContext,
  isSolanaWalletAdapter,
  ISolanaWalletAdapter,
  SolanaWalletContext,
  WalletReadyState,
} from "../../src/solana/types";

describe("Solana Types", () => {
  describe("Chain ID Constants", () => {
    it("should have correct chain ID for mainnet-beta", () => {
      expect(SOLANA_CHAIN_IDS["mainnet-beta"]).to.equal(900001);
    });

    it("should have correct chain ID for testnet", () => {
      expect(SOLANA_CHAIN_IDS["testnet"]).to.equal(900002);
    });

    it("should have correct chain ID for devnet", () => {
      expect(SOLANA_CHAIN_IDS["devnet"]).to.equal(900003);
    });

    it("should have correct chain ID for localnet", () => {
      expect(SOLANA_CHAIN_IDS["localnet"]).to.equal(900004);
    });

    it("should have reverse mapping from ID to cluster", () => {
      expect(SOLANA_CLUSTERS_BY_ID[900001]).to.equal("mainnet-beta");
      expect(SOLANA_CLUSTERS_BY_ID[900002]).to.equal("testnet");
      expect(SOLANA_CLUSTERS_BY_ID[900003]).to.equal("devnet");
      expect(SOLANA_CLUSTERS_BY_ID[900004]).to.equal("localnet");
    });

    it("should have mainnet-beta as default chain ID", () => {
      expect(DEFAULT_SOLANA_CHAIN_ID).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
    });

    it("should have high chain IDs to avoid collision with EVM chains", () => {
      // EVM chains typically have IDs < 100000
      Object.values(SOLANA_CHAIN_IDS).forEach((chainId) => {
        expect(chainId).to.be.greaterThan(100000);
      });
    });
  });

  describe("isSolanaWalletContext", () => {
    it("should return true for wallet context objects", () => {
      const mockContext: Partial<SolanaWalletContext> = {
        wallets: [],
        wallet: null,
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
        autoConnect: false,
        select: () => {},
        connect: async () => {},
        disconnect: async () => {},
        sendTransaction: async () => "",
      };

      expect(isSolanaWalletContext(mockContext as SolanaWalletContext)).to.be
        .true;
    });

    it("should return false for wallet adapter objects", () => {
      const mockAdapter: Partial<ISolanaWalletAdapter> = {
        name: "Test Wallet",
        url: "https://test.wallet",
        icon: "icon.png",
        readyState: WalletReadyState.Installed,
        publicKey: null,
        connecting: false,
        connected: false,
        connect: async () => {},
        disconnect: async () => {},
        on: () => {},
        off: () => {},
      };

      expect(isSolanaWalletContext(mockAdapter as ISolanaWalletAdapter)).to.be
        .false;
    });

    it("should return false for null/undefined", () => {
      expect(isSolanaWalletContext(null)).to.be.false;
      expect(isSolanaWalletContext(undefined)).to.be.false;
    });

    it("should return false for non-objects", () => {
      expect(isSolanaWalletContext("wallet" as any)).to.be.false;
      expect(isSolanaWalletContext(123 as any)).to.be.false;
    });
  });

  describe("isSolanaWalletAdapter", () => {
    it("should return true for wallet adapter objects", () => {
      const mockAdapter: Partial<ISolanaWalletAdapter> = {
        name: "Test Wallet",
        url: "https://test.wallet",
        icon: "icon.png",
        readyState: WalletReadyState.Installed,
        publicKey: null,
        connecting: false,
        connected: false,
        connect: async () => {},
        disconnect: async () => {},
        on: () => {},
        off: () => {},
      };

      expect(isSolanaWalletAdapter(mockAdapter as ISolanaWalletAdapter)).to.be
        .true;
    });

    it("should return false for wallet context objects", () => {
      const mockContext: Partial<SolanaWalletContext> = {
        wallets: [],
        wallet: null,
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
        autoConnect: false,
        select: () => {},
        connect: async () => {},
        disconnect: async () => {},
        sendTransaction: async () => "",
      };

      expect(isSolanaWalletAdapter(mockContext as SolanaWalletContext)).to.be
        .false;
    });

    it("should return false for null/undefined", () => {
      expect(isSolanaWalletAdapter(null)).to.be.false;
      expect(isSolanaWalletAdapter(undefined)).to.be.false;
    });
  });
});
