import { expect } from "chai";
import { describe, it } from "mocha";
import {
  SOLANA_CHAIN_IDS,
  SOLANA_CLUSTERS_BY_ID,
  DEFAULT_SOLANA_CHAIN_ID,
  isSolanaChainId,
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

  describe("isSolanaChainId", () => {
    it("should return true for Solana chain IDs", () => {
      expect(isSolanaChainId(900001)).to.be.true;
      expect(isSolanaChainId(900002)).to.be.true;
      expect(isSolanaChainId(900003)).to.be.true;
      expect(isSolanaChainId(900004)).to.be.true;
    });

    it("should return false for EVM chain IDs", () => {
      expect(isSolanaChainId(1)).to.be.false;
      expect(isSolanaChainId(137)).to.be.false;
    });

    it("should return false for null/undefined", () => {
      expect(isSolanaChainId(null)).to.be.false;
      expect(isSolanaChainId(undefined)).to.be.false;
    });
  });
});
