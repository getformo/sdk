import { describe, it } from "mocha";
import { expect } from "chai";
import {
  extractPrivyProperties,
  getPrivyWalletAddresses,
  PrivyUser,
} from "../../src/privy";

describe("Privy Utilities", () => {
  describe("extractPrivyProperties", () => {
    it("should extract core identifiers", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        createdAt: 1699900000000,
      };

      const result = extractPrivyProperties(user);

      expect(result.privyDid).to.equal("did:privy:abc123");
      expect(result.privyCreatedAt).to.equal(1699900000000);
    });

    it("should extract email from user.email", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        email: { address: "user@example.com" },
      };

      const result = extractPrivyProperties(user);

      expect(result.email).to.equal("user@example.com");
    });

    it("should extract social account usernames", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        twitter: { username: "twitteruser" },
        discord: { username: "discorduser#1234" },
        github: { username: "ghuser" },
        farcaster: { username: "fname", fid: 12345 },
      };

      const result = extractPrivyProperties(user);

      expect(result.twitter).to.equal("twitteruser");
      expect(result.discord).to.equal("discorduser#1234");
      expect(result.github).to.equal("ghuser");
      expect(result.farcaster).to.equal("fname");
      // farcasterFid should NOT be included
      expect(result).to.not.have.property("farcasterFid");
    });

    it("should extract social account emails", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        google: { email: "user@gmail.com" },
        apple: { email: "user@icloud.com" },
        linkedin: { email: "user@company.com" },
        spotify: { email: "user@spotify.com" },
        line: { email: "user@line.me" },
      };

      const result = extractPrivyProperties(user);

      expect(result.google).to.equal("user@gmail.com");
      expect(result.apple).to.equal("user@icloud.com");
      expect(result.linkedin).to.equal("user@company.com");
      expect(result.spotify).to.equal("user@spotify.com");
      expect(result.line).to.equal("user@line.me");
    });

    it("should fall back to google email if email is blank", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        google: { email: "user@gmail.com" },
      };

      const result = extractPrivyProperties(user);

      expect(result.email).to.equal("user@gmail.com");
    });

    it("should fall back to apple email if email and google are blank", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        apple: { email: "user@icloud.com" },
      };

      const result = extractPrivyProperties(user);

      expect(result.email).to.equal("user@icloud.com");
    });

    it("should fall back to linkedin email if email, google, and apple are blank", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedin: { email: "user@company.com" },
      };

      const result = extractPrivyProperties(user);

      expect(result.email).to.equal("user@company.com");
    });

    it("should prefer direct email over OAuth fallback", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        email: { address: "direct@example.com" },
        google: { email: "user@gmail.com" },
      };

      const result = extractPrivyProperties(user);

      expect(result.email).to.equal("direct@example.com");
    });

    it("should extract from linkedAccounts as fallback", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "twitter_oauth", username: "twitteruser" },
          { type: "github_oauth", username: "ghuser" },
          { type: "farcaster", username: "fname" },
        ],
      };

      const result = extractPrivyProperties(user);

      expect(result.twitter).to.equal("twitteruser");
      expect(result.github).to.equal("ghuser");
      expect(result.farcaster).to.equal("fname");
    });

    it("should use farcaster displayName as fallback if username is missing", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "farcaster", displayName: "Farcaster User" },
        ],
      };

      const result = extractPrivyProperties(user);

      expect(result.farcaster).to.equal("Farcaster User");
    });

    it("should handle user with no linked accounts", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
      };

      const result = extractPrivyProperties(user);

      expect(result.privyDid).to.equal("did:privy:abc123");
      expect(result.email).to.be.undefined;
      expect(result.twitter).to.be.undefined;
    });
  });

  describe("getPrivyWalletAddresses", () => {
    it("should extract wallet addresses from linkedAccounts", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          {
            type: "wallet",
            address: "0x1111111111111111111111111111111111111111",
            walletClientType: "metamask",
            chainType: "ethereum",
          },
          {
            type: "wallet",
            address: "0x2222222222222222222222222222222222222222",
            walletClientType: "privy",
            chainType: "ethereum",
          },
        ],
      };

      const result = getPrivyWalletAddresses(user);

      expect(result).to.have.length(2);
      expect(result[0].address).to.equal("0x1111111111111111111111111111111111111111");
      expect(result[0].walletClient).to.equal("metamask");
      expect(result[0].isEmbedded).to.be.false;
      expect(result[1].address).to.equal("0x2222222222222222222222222222222222222222");
      expect(result[1].walletClient).to.equal("privy");
      expect(result[1].isEmbedded).to.be.true;
    });

    it("should identify Privy embedded wallets", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          {
            type: "wallet",
            address: "0x1111111111111111111111111111111111111111",
            walletClientType: "privy",
          },
          {
            type: "wallet",
            address: "0x2222222222222222222222222222222222222222",
            walletClient: "privy", // alternative field name
          },
        ],
      };

      const result = getPrivyWalletAddresses(user);

      expect(result[0].isEmbedded).to.be.true;
      expect(result[1].isEmbedded).to.be.true;
    });

    it("should filter out non-wallet accounts", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          {
            type: "wallet",
            address: "0x1111111111111111111111111111111111111111",
          },
          { type: "email", address: "user@example.com" },
          { type: "google_oauth", email: "user@gmail.com" },
        ],
      };

      const result = getPrivyWalletAddresses(user);

      expect(result).to.have.length(1);
      expect(result[0].address).to.equal("0x1111111111111111111111111111111111111111");
    });

    it("should filter out wallets without addresses", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          {
            type: "wallet",
            address: "0x1111111111111111111111111111111111111111",
          },
          {
            type: "wallet",
            // no address
            walletClientType: "metamask",
          },
        ],
      };

      const result = getPrivyWalletAddresses(user);

      expect(result).to.have.length(1);
    });

    it("should return empty array for user with no linked accounts", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
      };

      const result = getPrivyWalletAddresses(user);

      expect(result).to.deep.equal([]);
    });

    it("should return empty array for user with no wallet accounts", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "email", address: "user@example.com" },
          { type: "google_oauth", email: "user@gmail.com" },
        ],
      };

      const result = getPrivyWalletAddresses(user);

      expect(result).to.deep.equal([]);
    });

    it("should include chainType when available", () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          {
            type: "wallet",
            address: "0x1111111111111111111111111111111111111111",
            chainType: "ethereum",
          },
          {
            type: "wallet",
            address: "0x2222222222222222222222222222222222222222",
            chainType: "solana",
          },
        ],
      };

      const result = getPrivyWalletAddresses(user);

      expect(result[0].chainType).to.equal("ethereum");
      expect(result[1].chainType).to.equal("solana");
    });
  });
});
