import { describe, it } from "mocha";
import { expect } from "chai";
import {
  parsePrivyProperties,
  PrivyUser,
} from "../../src/privy";

describe("Privy Utilities", () => {
  describe("parsePrivyProperties", () => {
    describe("properties extraction", () => {
      it("should extract core identifiers", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          createdAt: new Date(1699900000000),
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.privyDid).to.equal("did:privy:abc123");
        expect(properties.privyCreatedAt).to.equal(1699900000000);
      });

      it("should extract email from user.email", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          email: { address: "user@example.com" },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.email).to.equal("user@example.com");
      });

      it("should extract social account usernames", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          twitter: { subject: "tw1", username: "twitteruser", name: null, profilePictureUrl: null },
          discord: { subject: "dc1", username: "discorduser#1234", email: null },
          github: { subject: "gh1", username: "ghuser", name: null },
          farcaster: { fid: 12345, ownerAddress: "0x0", username: "fname", displayName: null, bio: null, pfp: null },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.twitter).to.equal("twitteruser");
        expect(properties.discord).to.equal("discorduser#1234");
        expect(properties.github).to.equal("ghuser");
        expect(properties.farcaster).to.equal("fname");
        // farcasterFid should NOT be included
        expect(properties).to.not.have.property("farcasterFid");
      });

      it("should extract social account emails", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          google: { subject: "g1", email: "user@gmail.com", name: null },
          apple: { subject: "a1", email: "user@icloud.com" },
          linkedin: { subject: "li1", email: "user@company.com", name: null, vanityName: null },
          spotify: { subject: "sp1", email: "user@spotify.com", name: null },
          line: { subject: "ln1", email: "user@line.me", name: null },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.google).to.equal("user@gmail.com");
        expect(properties.apple).to.equal("user@icloud.com");
        expect(properties.linkedin).to.equal("user@company.com");
        expect(properties.spotify).to.equal("user@spotify.com");
        expect(properties.line).to.equal("user@line.me");
      });

      it("should fall back to google email if email is blank", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          google: { subject: "g1", email: "user@gmail.com", name: null },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.email).to.equal("user@gmail.com");
      });

      it("should fall back to apple email if email and google are blank", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          apple: { subject: "a1", email: "user@icloud.com" },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.email).to.equal("user@icloud.com");
      });

      it("should fall back to linkedin email if email, google, and apple are blank", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          linkedin: { subject: "li1", email: "user@company.com", name: null, vanityName: null },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.email).to.equal("user@company.com");
      });

      it("should prefer direct email over OAuth fallback", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          email: { address: "direct@example.com" },
          google: { subject: "g1", email: "user@gmail.com", name: null },
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.email).to.equal("direct@example.com");
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

        const { properties } = parsePrivyProperties(user);

        expect(properties.twitter).to.equal("twitteruser");
        expect(properties.github).to.equal("ghuser");
        expect(properties.farcaster).to.equal("fname");
      });

      it("should use farcaster displayName as fallback if username is missing", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          linkedAccounts: [
            { type: "farcaster", displayName: "Farcaster User" },
          ],
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.farcaster).to.equal("Farcaster User");
      });

      it("should handle user with no linked accounts", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
        };

        const { properties } = parsePrivyProperties(user);

        expect(properties.privyDid).to.equal("did:privy:abc123");
        expect(properties.email).to.be.undefined;
        expect(properties.twitter).to.be.undefined;
      });
    });

    describe("wallets extraction", () => {
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

        const { wallets } = parsePrivyProperties(user);

        expect(wallets).to.have.length(2);
        expect(wallets[0].address).to.equal("0x1111111111111111111111111111111111111111");
        expect(wallets[0].walletClient).to.equal("metamask");
        expect(wallets[0].isEmbedded).to.be.false;
        expect(wallets[1].address).to.equal("0x2222222222222222222222222222222222222222");
        expect(wallets[1].walletClient).to.equal("privy");
        expect(wallets[1].isEmbedded).to.be.true;
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

        const { wallets } = parsePrivyProperties(user);

        expect(wallets[0].isEmbedded).to.be.true;
        expect(wallets[1].isEmbedded).to.be.true;
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

        const { wallets } = parsePrivyProperties(user);

        expect(wallets).to.have.length(1);
        expect(wallets[0].address).to.equal("0x1111111111111111111111111111111111111111");
      });

      it("should extract smart wallet accounts", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          linkedAccounts: [
            {
              type: "wallet",
              address: "0x1111111111111111111111111111111111111111",
              walletClientType: "metamask",
            },
            {
              type: "smart_wallet",
              address: "0x3333333333333333333333333333333333333333",
              walletClientType: "privy",
            },
          ],
        };

        const { wallets } = parsePrivyProperties(user);

        expect(wallets).to.have.length(2);
        expect(wallets[0].address).to.equal("0x1111111111111111111111111111111111111111");
        expect(wallets[1].address).to.equal("0x3333333333333333333333333333333333333333");
        expect(wallets[1].isEmbedded).to.be.true;
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

        const { wallets } = parsePrivyProperties(user);

        expect(wallets).to.have.length(1);
      });

      it("should return empty array for user with no linked accounts", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
        };

        const { wallets } = parsePrivyProperties(user);

        expect(wallets).to.deep.equal([]);
      });

      it("should return empty array for user with no wallet accounts", () => {
        const user: PrivyUser = {
          id: "did:privy:abc123",
          linkedAccounts: [
            { type: "email", address: "user@example.com" },
            { type: "google_oauth", email: "user@gmail.com" },
          ],
        };

        const { wallets } = parsePrivyProperties(user);

        expect(wallets).to.deep.equal([]);
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

        const { wallets } = parsePrivyProperties(user);

        expect(wallets[0].chainType).to.equal("ethereum");
        expect(wallets[1].chainType).to.equal("solana");
      });
    });
  });
});
