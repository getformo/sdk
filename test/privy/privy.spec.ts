import { describe, it } from "mocha";
import { expect } from "chai";
import {
  parsePrivyProperties,
  identifyPrivyUser,
  PrivyUser,
} from "../../src/privy";
import type { IFormoAnalytics } from "../../src/types";

interface RecordedIdentify {
  params: {
    address: string;
    userId?: string;
    rdns?: string;
    providerName?: string;
  };
  properties?: Record<string, unknown>;
}

/**
 * Minimal IFormoAnalytics stub that records identify() calls so we can assert
 * ordering, attribution flags, and forwarded per-wallet metadata.
 */
function makeRecorder(): { analytics: IFormoAnalytics; calls: RecordedIdentify[] } {
  const calls: RecordedIdentify[] = [];
  const analytics = {
    identify: async (params: any, properties: any) => {
      calls.push({ params, properties });
    },
  } as unknown as IFormoAnalytics;
  return { analytics, calls };
}

const EMBEDDED = "0x1111111111111111111111111111111111111111";
const EXTERNAL = "0x2222222222222222222222222222222222222222";
const EXTERNAL_2 = "0x3333333333333333333333333333333333333333";

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

  describe("identifyPrivyUser", () => {
    it("identifies every linked wallet tagged with the Privy DID", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        email: { address: "user@example.com" },
        linkedAccounts: [
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask", chainType: "ethereum" },
          { type: "wallet", address: EMBEDDED, walletClientType: "privy", chainType: "ethereum" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user);

      expect(calls).to.have.length(2);
      for (const call of calls) {
        expect(call.params.userId).to.equal("did:privy:abc123");
      }
    });

    it("forwards per-wallet metadata and shared profile properties", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        email: { address: "user@example.com" },
        linkedAccounts: [
          { type: "wallet", address: EMBEDDED, walletClientType: "privy", chainType: "ethereum" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user);

      expect(calls).to.have.length(1);
      const props = calls[0].properties!;
      // per-wallet metadata
      expect(props.wallet_client).to.equal("privy");
      expect(props.chain_type).to.equal("ethereum");
      expect(props.is_embedded).to.equal(true);
      // shared profile properties
      expect(props.privyDid).to.equal("did:privy:abc123");
      expect(props.email).to.equal("user@example.com");
    });

    it("omits wallet_client/chain_type when absent but always sends is_embedded", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [{ type: "wallet", address: EXTERNAL }],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user);

      const props = calls[0].properties!;
      expect(props).to.not.have.property("wallet_client");
      expect(props).to.not.have.property("chain_type");
      expect(props.is_embedded).to.equal(false);
    });

    it("attributes to the provided active wallet and identifies it last", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
          { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
          { type: "wallet", address: EXTERNAL_2, walletClientType: "rainbow" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user, { activeAddress: EXTERNAL });

      // Active wallet is identified last, so it wins attribution (identify()
      // sets the current address on each call, last write wins).
      expect(calls[calls.length - 1].params.address).to.equal(EXTERNAL);
      // ...and every wallet is still identified for clustering.
      expect(calls.map((c) => c.params.address)).to.have.members([
        EMBEDDED,
        EXTERNAL,
        EXTERNAL_2,
      ]);
    });

    it("matches the active wallet case-insensitively", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user, {
        activeAddress: EMBEDDED.toUpperCase(),
      });

      // Case-insensitive match still puts the active wallet last.
      expect(calls[calls.length - 1].params.address).to.equal(EMBEDDED);
    });

    it("falls back to embedded-first order and attributes to the last external wallet", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
          { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user);

      // Embedded wallet is identified first...
      expect(calls[0].params.address).to.equal(EMBEDDED);
      // ...and the external wallet is identified last, so it owns attribution.
      expect(calls[1].params.address).to.equal(EXTERNAL);
    });

    it("defaults the active wallet to user.wallet when activeAddress is omitted", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        // Privy's surfaced primary wallet is the embedded one.
        wallet: { address: EMBEDDED },
        linkedAccounts: [
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
          { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user);

      // user.wallet (EMBEDDED) is treated as active → identified last,
      // overriding the embedded-first heuristic (which would end on EXTERNAL).
      expect(calls[calls.length - 1].params.address).to.equal(EMBEDDED);
    });

    it("lets an explicit activeAddress override user.wallet", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        wallet: { address: EMBEDDED },
        linkedAccounts: [
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
          { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user, { activeAddress: EXTERNAL });

      // Explicit override wins over user.wallet.
      expect(calls[calls.length - 1].params.address).to.equal(EXTERNAL);
    });

    it("merges options.properties into every identify call", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        linkedAccounts: [
          { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
        ],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user, {
        properties: { plan: "pro" },
      });

      expect(calls).to.have.length(2);
      for (const call of calls) {
        expect(call.properties!.plan).to.equal("pro");
      }
    });

    it("does nothing when the user has no linked wallets", async () => {
      const user: PrivyUser = {
        id: "did:privy:abc123",
        email: { address: "user@example.com" },
        linkedAccounts: [{ type: "email", address: "user@example.com" }],
      };
      const { analytics, calls } = makeRecorder();

      await identifyPrivyUser(analytics, user);

      expect(calls).to.have.length(0);
    });
  });
});
