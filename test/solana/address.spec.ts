import { expect } from "chai";
import { describe, it } from "mocha";
import {
  isSolanaAddress,
  getValidSolanaAddress,
  isBlockedSolanaAddress,
  publicKeyToAddress,
  areSolanaAddressesEqual,
  SOLANA_SYSTEM_ADDRESSES,
} from "../../src/solana/address";
import { SolanaPublicKey } from "../../src/solana/types";

describe("Solana Address Utilities", () => {
  describe("isSolanaAddress", () => {
    it("should return true for a valid Solana address (typical wallet)", () => {
      // Example Solana mainnet wallet address
      expect(isSolanaAddress("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn")).to.be
        .true;
    });

    it("should return true for a valid Solana address (32 chars minimum)", () => {
      expect(isSolanaAddress("11111111111111111111111111111111")).to.be.true;
    });

    it("should return true for a valid Solana address (44 chars maximum)", () => {
      expect(
        isSolanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
      ).to.be.true;
    });

    it("should return false for addresses that are too short", () => {
      expect(isSolanaAddress("FDKJvWcJNe6wecbg")).to.be.false;
    });

    it("should return false for addresses that are too long", () => {
      expect(
        isSolanaAddress(
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4TnFDKJvWcJNe6wecbg"
        )
      ).to.be.false;
    });

    it("should return false for invalid Base58 characters (0, O, I, l)", () => {
      // These characters are not in Base58
      expect(isSolanaAddress("0DKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfW")).to.be.false;
      expect(isSolanaAddress("ODKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfW")).to.be.false;
      expect(isSolanaAddress("IDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfW")).to.be.false;
      expect(isSolanaAddress("lDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfW")).to.be.false;
    });

    it("should return false for non-string values", () => {
      expect(isSolanaAddress(null)).to.be.false;
      expect(isSolanaAddress(undefined)).to.be.false;
      expect(isSolanaAddress(123)).to.be.false;
      expect(isSolanaAddress({})).to.be.false;
      expect(isSolanaAddress([])).to.be.false;
    });

    it("should return false for empty strings", () => {
      expect(isSolanaAddress("")).to.be.false;
      expect(isSolanaAddress("   ")).to.be.false;
    });

    it("should handle addresses with leading/trailing whitespace", () => {
      expect(
        isSolanaAddress("  FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn  ")
      ).to.be.true;
    });

    it("should return false for Ethereum addresses (hex format)", () => {
      expect(isSolanaAddress("0xa5cc3c03994DB5b0d9A5eEdD10CabaB0813678AC")).to.be
        .false;
    });
  });

  describe("getValidSolanaAddress", () => {
    it("should return trimmed address for valid addresses", () => {
      const result = getValidSolanaAddress(
        "  FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn  "
      );
      expect(result).to.equal("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn");
    });

    it("should return null for invalid addresses", () => {
      expect(getValidSolanaAddress("invalid")).to.be.null;
      expect(getValidSolanaAddress("")).to.be.null;
      expect(getValidSolanaAddress(null)).to.be.null;
      expect(getValidSolanaAddress(undefined)).to.be.null;
    });

    it("should handle PublicKey objects", () => {
      const mockPublicKey: SolanaPublicKey = {
        toBase58: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toString: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toBytes: () => new Uint8Array(32),
        equals: () => false,
      };

      const result = getValidSolanaAddress(mockPublicKey);
      expect(result).to.equal("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn");
    });

    it("should return null for PublicKey that throws", () => {
      const mockPublicKey: SolanaPublicKey = {
        toBase58: () => {
          throw new Error("Invalid key");
        },
        toString: () => "",
        toBytes: () => new Uint8Array(32),
        equals: () => false,
      };

      const result = getValidSolanaAddress(mockPublicKey);
      expect(result).to.be.null;
    });
  });

  describe("isBlockedSolanaAddress", () => {
    it("should return true for system program address", () => {
      expect(isBlockedSolanaAddress(SOLANA_SYSTEM_ADDRESSES.SYSTEM_PROGRAM)).to
        .be.true;
    });

    it("should return true for token program address", () => {
      expect(isBlockedSolanaAddress(SOLANA_SYSTEM_ADDRESSES.TOKEN_PROGRAM)).to.be
        .true;
    });

    it("should return false for normal wallet addresses", () => {
      expect(
        isBlockedSolanaAddress("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn")
      ).to.be.false;
    });

    it("should return false for invalid addresses", () => {
      expect(isBlockedSolanaAddress("invalid")).to.be.false;
      expect(isBlockedSolanaAddress(null)).to.be.false;
      expect(isBlockedSolanaAddress(undefined)).to.be.false;
    });
  });

  describe("publicKeyToAddress", () => {
    it("should convert valid PublicKey to address string", () => {
      const mockPublicKey: SolanaPublicKey = {
        toBase58: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toString: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toBytes: () => new Uint8Array(32),
        equals: () => false,
      };

      expect(publicKeyToAddress(mockPublicKey)).to.equal(
        "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn"
      );
    });

    it("should return null for null publicKey", () => {
      expect(publicKeyToAddress(null)).to.be.null;
    });

    it("should return null for undefined publicKey", () => {
      expect(publicKeyToAddress(undefined)).to.be.null;
    });
  });

  describe("areSolanaAddressesEqual", () => {
    it("should return true for equal addresses", () => {
      expect(
        areSolanaAddressesEqual(
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn"
        )
      ).to.be.true;
    });

    it("should return false for different addresses", () => {
      expect(
        areSolanaAddressesEqual(
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        )
      ).to.be.false;
    });

    it("should be case-sensitive (unlike Ethereum)", () => {
      expect(
        areSolanaAddressesEqual(
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
          "fdkjvwcjne6wecbgdydfpcfgs14ajnvsufwqrywln4tn"
        )
      ).to.be.false;
    });

    it("should return false for null/undefined", () => {
      expect(
        areSolanaAddressesEqual(
          null,
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn"
        )
      ).to.be.false;
      expect(
        areSolanaAddressesEqual(
          "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
          null
        )
      ).to.be.false;
      expect(areSolanaAddressesEqual(null, null)).to.be.false;
    });

    it("should handle PublicKey objects", () => {
      const mockPublicKey1: SolanaPublicKey = {
        toBase58: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toString: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toBytes: () => new Uint8Array(32),
        equals: () => false,
      };

      const mockPublicKey2: SolanaPublicKey = {
        toBase58: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toString: () => "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn",
        toBytes: () => new Uint8Array(32),
        equals: () => false,
      };

      expect(areSolanaAddressesEqual(mockPublicKey1, mockPublicKey2)).to.be.true;
    });
  });
});
