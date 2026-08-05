import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { identifyPrivyUser, PrivyUser } from "../../src/privy";
import { initStorageManager } from "../../src/storage";

/**
 * End-to-end coverage for identifyPrivyUser driving the REAL FormoAnalytics
 * identify() — not a stub. Verifies that:
 * - every linked wallet emits an identify event tagged with the Privy DID,
 * - the per-wallet metadata is forwarded,
 * - only the active wallet ends up as the SDK's currentAddress (no hijack),
 * - the userId-aware session dedup re-emits when a DID is attached to a wallet
 *   that was previously identified anonymously.
 */
describe("identifyPrivyUser (integration with real identify)", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let originalGlobalThis: PropertyDescriptor | undefined;

  const EMBEDDED = "0x1111111111111111111111111111111111111111";
  const EXTERNAL = "0x2222222222222222222222222222222222222222";
  const EXTERNAL_2 = "0x3333333333333333333333333333333333333333";
  const DID = "did:privy:integration";

  async function makeAnalytics(
    tracking?: boolean | { excludeChains?: number[] }
  ): Promise<FormoAnalytics> {
    // wagmi mode skips browser-dependent EIP-1193/EIP-6963 provider detection.
    const mockWagmiConfig = {
      subscribe: sandbox.stub().returns(() => {}),
      state: {
        status: "disconnected",
        connections: new Map(),
        current: undefined,
        chainId: undefined,
      },
      _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
    };
    return FormoAnalytics.init("test-write-key", {
      wagmi: { config: mockWagmiConfig as any },
      ...(tracking !== undefined ? { tracking: tracking as any } : {}),
    });
  }

  /** Stub the event sink and return the list of emitted identify events. */
  function captureIdentifies(formo: FormoAnalytics): any[] {
    const events: any[] = [];
    sandbox
      .stub((formo as any).eventManager, "addEvent")
      .callsFake(async (event: any) => {
        events.push(event);
      });
    return events;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com",
    });
    Object.defineProperty(global, "window", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "document", {
      value: jsdom.window.document, writable: true, configurable: true,
    });
    Object.defineProperty(global, "location", {
      value: jsdom.window.location, writable: true, configurable: true,
    });
    // globalThis is a real Node binding, unlike window/document/localStorage
    // which don't exist here natively. Capture its descriptor so afterEach can
    // put it back — deleting it would unbind globalThis process-wide for every
    // test file that runs after this one.
    originalGlobalThis = Object.getOwnPropertyDescriptor(global, "globalThis");
    Object.defineProperty(global, "globalThis", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "navigator", {
      value: jsdom.window.navigator, writable: true, configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: jsdom.window.localStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "sessionStorage", {
      value: jsdom.window.sessionStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid-1234" },
      writable: true, configurable: true,
    });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    sandbox.restore();
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).location;
    if (originalGlobalThis) {
      Object.defineProperty(global, "globalThis", originalGlobalThis);
    } else {
      delete (global as any).globalThis;
    }
    delete (global as any).navigator;
    delete (global as any).localStorage;
    delete (global as any).sessionStorage;
    delete (global as any).crypto;
  });

  it("emits one identify per wallet tagged with the DID and pins attribution to the active wallet", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    const user: PrivyUser = {
      id: DID,
      email: { address: "user@example.com" },
      linkedAccounts: [
        // active wallet is deliberately NOT last in link order, to prove the
        // loop does not simply leave attribution on the last linked wallet.
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask", chainType: "ethereum" },
        { type: "wallet", address: EMBEDDED, walletClientType: "privy", chainType: "ethereum" },
        { type: "wallet", address: EXTERNAL_2, walletClientType: "rainbow", chainType: "ethereum" },
      ],
    };

    await identifyPrivyUser(formo, user, { activeAddress: EXTERNAL });

    // One identify event per linked wallet.
    const addresses = events.map((e) => e.address.toLowerCase());
    expect(events).to.have.length(3);
    expect(addresses).to.have.members([EMBEDDED, EXTERNAL, EXTERNAL_2]);

    // Every event carries the shared DID and profile properties.
    for (const e of events) {
      expect(e.userId).to.equal(DID);
      expect(e.properties.privyDid).to.equal(DID);
      expect(e.properties.email).to.equal("user@example.com");
      expect(e.properties).to.have.property("is_embedded");
    }

    // Attribution stays on the active wallet, not the last-linked wallet.
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
  });

  it("dispatches identify(user) through the core identify()", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    const user: PrivyUser = {
      id: DID,
      email: { address: "user@example.com" },
      linkedAccounts: [
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask", chainType: "ethereum" },
        { type: "wallet", address: EMBEDDED, walletClientType: "privy", chainType: "ethereum" },
      ],
    };

    // The single-call form: no separate helper or hook.
    await formo.identify(user, { activeAddress: EXTERNAL });

    // Both linked wallets identified under the DID, with metadata forwarded.
    expect(events).to.have.length(2);
    expect(events.map((e) => e.address.toLowerCase())).to.have.members([
      EMBEDDED,
      EXTERNAL,
    ]);
    for (const e of events) {
      expect(e.userId).to.equal(DID);
      expect(e.properties.email).to.equal("user@example.com");
      expect(e.properties).to.have.property("is_embedded");
    }
    // Only the active wallet (setActive) owns attribution.
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
  });

  it("takes the Privy form from shape alone, with no options argument", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    // The simplest possible call: just the user.
    await formo.identify({
      id: DID,
      wallet: { address: EXTERNAL },
      linkedAccounts: [
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
      ],
    });

    expect(events).to.have.length(2);
    for (const e of events) expect(e.userId).to.equal(DID);
    // With no activeAddress, attribution falls to Privy's surfaced primary.
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
  });

  it("leaves every existing address-keyed identify form untouched", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    // Shape dispatch keys on a string `id` AND no `address`, so none of the
    // pre-existing call forms can be mistaken for a Privy user.
    await formo.identify({ address: EXTERNAL });
    await formo.identify({ address: EMBEDDED, userId: "legacy-user-id" });
    await formo.identify(
      { address: EXTERNAL_2, providerName: "MetaMask", rdns: "io.metamask" },
      { plan: "pro" }
    );

    expect(events).to.have.length(3);
    expect(events.map((e) => e.address.toLowerCase())).to.have.members([
      EXTERNAL,
      EMBEDDED,
      EXTERNAL_2,
    ]);
    // A userId passed the old way still lands on the event.
    expect(events[1].userId).to.equal("legacy-user-id");
    expect(events[2].properties.plan).to.equal("pro");
  });

  it("does not treat a normal identify carrying a `privy` property as the Privy form", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    // A regular identify whose params is address-shaped must not dispatch to the
    // Privy form even if a property happens to be named `privy: true` — the
    // wallet/user must still be recorded, not silently dropped.
    await formo.identify(
      { address: EXTERNAL, userId: "plain" },
      { privy: true, plan: "pro" }
    );

    expect(events).to.have.length(1);
    expect(events[0].address.toLowerCase()).to.equal(EXTERNAL);
    expect(events[0].userId).to.equal("plain");
    expect(events[0].properties.privy).to.equal(true);
    expect(events[0].properties.plan).to.equal("pro");
  });

  it("prefers the already-connected wallet over user.wallet for attribution", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    // A real connect sets currentAddress to the external wallet.
    await formo.identify({ address: EXTERNAL, rdns: "io.metamask" });
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);

    // user.wallet is the embedded wallet — Privy's primary, different from the
    // wallet the user actually connected.
    const user: PrivyUser = {
      id: DID,
      wallet: { address: EMBEDDED },
      linkedAccounts: [
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
      ],
    };

    // No activeAddress passed: the flag form must keep attribution on the
    // connected wallet, not overwrite it with user.wallet.
    await formo.identify(user);

    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
  });

  it("preserves the connected wallet via the direct identifyPrivyUser() form too", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    await formo.identify({ address: EXTERNAL, rdns: "io.metamask" });
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);

    const user: PrivyUser = {
      id: DID,
      wallet: { address: EMBEDDED }, // Privy's primary is the embedded wallet
      linkedAccounts: [
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
      ],
    };

    // Direct helper, no activeAddress: it must read the SDK's connected wallet
    // and keep attribution there, identical to the flag form (not switch to
    // user.wallet).
    await identifyPrivyUser(formo, user);

    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
  });

  it("preserves a connected wallet that is not linked in Privy", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    // Connect a wallet that is NOT among the user's Privy linked wallets
    // (e.g. a wagmi wallet connected before being linked in Privy).
    const UNLINKED = "0x4444444444444444444444444444444444444444";
    await formo.identify({ address: UNLINKED, rdns: "io.metamask" });
    expect(formo.currentAddress?.toLowerCase()).to.equal(UNLINKED);

    const user: PrivyUser = {
      id: DID,
      wallet: { address: EMBEDDED },
      linkedAccounts: [
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
      ],
    };

    await formo.identify(user);

    // The linked wallets are still identified for clustering...
    const linkedIdentifies = events.filter((e) =>
      [EMBEDDED, EXTERNAL].includes(e.address.toLowerCase())
    );
    expect(linkedIdentifies).to.have.length(2);
    // ...but attribution is preserved on the connected (unlinked) wallet, not
    // overwritten by an arbitrary linked wallet.
    expect(formo.currentAddress?.toLowerCase()).to.equal(UNLINKED);
    // ...and the unlinked wallet is NOT falsely tagged with the Privy DID
    // (currentUserId must not have been repointed by the clustering identifies).
    expect(formo.currentUserId).to.not.equal(DID);
  });

  it("clears a stale EVM chain id when the active Privy wallet is Solana", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    // A valid Base58 Solana address (canonical wrapped-SOL mint).
    const SOL = "So11111111111111111111111111111111111111112";

    // Establish an EVM chain first.
    await formo.connect({ chainId: 1, address: EXTERNAL });
    expect(formo.currentChainId).to.equal(1);

    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [
        { type: "wallet", address: SOL, walletClientType: "phantom", chainType: "solana" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask", chainType: "ethereum" },
      ],
    };

    // Make the Solana wallet the active one.
    await formo.identify(user, { activeAddress: SOL });

    expect(formo.currentAddress).to.equal(SOL);
    // The stale EVM chain id (1) must be cleared so the Solana address isn't
    // paired with an EVM chain in events / the active-wallet cookie.
    expect(formo.currentChainId).to.be.oneOf([undefined, null]);
  });

  it("infers the EVM namespace from the address when Privy omits chainType", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    const SOL = "So11111111111111111111111111111111111111112";

    // Start on a Solana chain.
    // 900001 = Solana mainnet-beta in this SDK's chain-id space.
    await formo.connect({ chainId: 900001, address: SOL });
    const solanaChainId = formo.currentChainId;

    // A smart_wallet entry is `{ type, address, smartWalletType }` — Privy
    // sends no chainType. The 0x address is still unambiguously EVM, so the
    // stale Solana chain id must be cleared rather than left paired with it.
    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [{ type: "smart_wallet", address: EXTERNAL }],
    };

    await formo.identify(user, { activeAddress: EXTERNAL });

    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
    expect(formo.currentChainId).to.not.equal(solanaChainId);
    expect(formo.currentChainId).to.be.oneOf([undefined, null]);
  });

  it("leaves the chain id alone when the namespace cannot be determined", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    const SOL = "So11111111111111111111111111111111111111112";

    // 900001 = Solana mainnet-beta in this SDK's chain-id space.
    await formo.connect({ chainId: 900001, address: SOL });
    const solanaChainId = formo.currentChainId;

    // A non-0x address with no chainType proves nothing (it could be Solana,
    // Bitcoin, Cosmos…), so the chain id must be left untouched rather than
    // cleared on a guess.
    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [{ type: "wallet", address: SOL }],
    };

    await formo.identify(user, { activeAddress: SOL });

    expect(formo.currentChainId).to.equal(solanaChainId);
  });

  it("does not treat an unrecognized chainType as EVM", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    const SOL = "So11111111111111111111111111111111111111112";
    const BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    await formo.connect({ chainId: 900001, address: SOL });
    const solanaChainId = formo.currentChainId;

    // "bitcoin" is neither solana nor ethereum. Classifying anything non-solana
    // as EVM would clear a perfectly valid Solana chain id here.
    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [{ type: "wallet", address: BTC, chainType: "bitcoin" }],
    };

    await formo.identify(user, { activeAddress: BTC });

    expect(formo.currentChainId).to.equal(solanaChainId);
  });

  it("still emits identifies when on an excluded chain but activating a Solana wallet", async () => {
    // Chain 1 (EVM) is excluded from tracking.
    const formo = await makeAnalytics({ excludeChains: [1] });
    const events = captureIdentifies(formo);

    const SOL = "So11111111111111111111111111111111111111112";

    // The current chain is the excluded EVM chain.
    await formo.connect({ chainId: 1, address: EXTERNAL });
    expect(formo.currentChainId).to.equal(1);

    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [
        { type: "wallet", address: SOL, walletClientType: "phantom", chainType: "solana" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask", chainType: "ethereum" },
      ],
    };

    // Activate the Solana wallet. The chain must be reconciled BEFORE emitting,
    // otherwise every inner identify is dropped by the excluded EVM chain and
    // the Privy identity is silently lost.
    await formo.identify(user, { activeAddress: SOL });

    expect(events.map((e) => e.address)).to.include(SOL);
    for (const e of events) expect(e.userId).to.equal(DID);
  });

  it("reconciles chain via the direct identifyPrivyUser() entry point too", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    const SOL = "So11111111111111111111111111111111111111112";
    await formo.connect({ chainId: 1, address: EXTERNAL });
    expect(formo.currentChainId).to.equal(1);

    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [
        { type: "wallet", address: SOL, walletClientType: "phantom", chainType: "solana" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask", chainType: "ethereum" },
      ],
    };

    // Called directly (not via the flag form) — must reconcile chain the same way.
    await identifyPrivyUser(formo, user, { activeAddress: SOL });

    expect(formo.currentAddress).to.equal(SOL);
    expect(formo.currentChainId).to.be.oneOf([undefined, null]);
  });

  it("does not let a non-active linked wallet hijack currentAddress after a real connect", async () => {
    const formo = await makeAnalytics();
    captureIdentifies(formo);

    // Simulate the user having connected an external wallet first.
    await formo.identify({ address: EXTERNAL, rdns: "io.metamask" });
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);

    // Now identify the Privy user, telling the SDK EXTERNAL is the active one.
    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
      ],
    };
    await identifyPrivyUser(formo, user, { activeAddress: EXTERNAL });

    // The active wallet (EXTERNAL) is identified last, so even though the
    // embedded wallet is also identified during the call, attribution ends up
    // on EXTERNAL rather than an arbitrary linked wallet.
    expect(formo.currentAddress?.toLowerCase()).to.equal(EXTERNAL);
  });

  it("dedups a repeated call but re-emits when a DID is attached to an anonymous wallet", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    // Wallet identified anonymously first (e.g. on connect).
    await formo.identify({ address: EMBEDDED, rdns: "io.metamask" });
    expect(events).to.have.length(1);

    const user: PrivyUser = {
      id: DID,
      linkedAccounts: [{ type: "wallet", address: EMBEDDED, walletClientType: "privy" }],
    };

    // Attaching the DID re-emits (userId folded into the dedup key).
    await identifyPrivyUser(formo, user);
    expect(events).to.have.length(2);
    expect(events[1].userId).to.equal(DID);

    // Running the exact same identify again is deduped — no new event.
    await identifyPrivyUser(formo, user);
    expect(events).to.have.length(2);
  });

  it("re-emits every linked wallet when the user links a new account", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    const linkedAccounts = [
      { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
      { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
    ];
    const before: PrivyUser = { id: DID, linkedAccounts };

    await identifyPrivyUser(formo, before);
    expect(events).to.have.length(2);

    // The user links a Google account. Same wallets, same DID — only the
    // profile changed. Without the properties fingerprint in the dedup key
    // both wallets would dedupe and `google` would never reach Formo.
    const after: PrivyUser = {
      id: DID,
      linkedAccounts: [
        ...linkedAccounts,
        { type: "google_oauth", email: "user@example.com", subject: "g1" },
      ],
      google: { subject: "g1", email: "user@example.com", name: null },
    };

    await identifyPrivyUser(formo, after);
    expect(events).to.have.length(4);
    expect(events[2].properties.google).to.equal("user@example.com");
    expect(events[3].properties.google).to.equal("user@example.com");
    // Both re-emits still carry the DID, so clustering is preserved.
    expect(events[2].userId).to.equal(DID);
    expect(events[3].userId).to.equal(DID);

    // A repeat of the post-link state is deduped again.
    await identifyPrivyUser(formo, after);
    expect(events).to.have.length(4);
  });

  it("re-emits every wallet again for each successive social link", async () => {
    // Mirrors a real session: a 3-wallet user links X, then links Discord.
    // Each link must produce its own wave of one identify per wallet, with the
    // properties accumulating — the second link is the case that would regress
    // if the fingerprint were computed once and cached rather than per call.
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    const wallets = [
      { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
      { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
      { type: "wallet", address: EXTERNAL_2, walletClientType: "metamask" },
    ];

    await identifyPrivyUser(formo, { id: DID, linkedAccounts: wallets });
    expect(events).to.have.length(3);

    // Link X.
    await identifyPrivyUser(formo, {
      id: DID,
      linkedAccounts: [
        ...wallets,
        { type: "twitter_oauth", subject: "t1", username: "yosriady" },
      ],
      twitter: {
        subject: "t1",
        username: "yosriady",
        name: null,
        profilePictureUrl: null,
      },
    });
    expect(events).to.have.length(6);
    const afterTwitter = events.slice(3);
    expect(afterTwitter.map((e) => e.properties.twitter)).to.deep.equal([
      "yosriady",
      "yosriady",
      "yosriady",
    ]);
    expect(afterTwitter.every((e) => e.properties.discord === undefined)).to.equal(
      true
    );

    // Link Discord on top. The DID and wallet set are unchanged, so only the
    // properties fingerprint distinguishes this from the previous state.
    await identifyPrivyUser(formo, {
      id: DID,
      linkedAccounts: [
        ...wallets,
        { type: "twitter_oauth", subject: "t1", username: "yosriady" },
        { type: "discord_oauth", subject: "d1", username: "yosriady#0" },
      ],
      twitter: {
        subject: "t1",
        username: "yosriady",
        name: null,
        profilePictureUrl: null,
      },
      discord: { subject: "d1", username: "yosriady#0", email: null },
    });
    expect(events).to.have.length(9);
    const afterDiscord = events.slice(6);
    expect(afterDiscord.map((e) => e.address?.toLowerCase())).to.have.members([
      EMBEDDED,
      EXTERNAL,
      EXTERNAL_2,
    ]);
    for (const e of afterDiscord) {
      expect(e.userId).to.equal(DID);
      expect(e.properties.twitter).to.equal("yosriady");
      expect(e.properties.discord).to.equal("yosriady#0");
    }

    // Re-running the final state is deduped — three waves, not four.
    await identifyPrivyUser(formo, {
      id: DID,
      linkedAccounts: [
        ...wallets,
        { type: "twitter_oauth", subject: "t1", username: "yosriady" },
        { type: "discord_oauth", subject: "d1", username: "yosriady#0" },
      ],
      twitter: {
        subject: "t1",
        username: "yosriady",
        name: null,
        profilePictureUrl: null,
      },
      discord: { subject: "d1", username: "yosriady#0", email: null },
    });
    expect(events).to.have.length(9);
  });

  it("does not re-emit surviving wallets when another wallet is unlinked", async () => {
    const formo = await makeAnalytics();
    const events = captureIdentifies(formo);

    const both: PrivyUser = {
      id: DID,
      linkedAccounts: [
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
        { type: "wallet", address: EXTERNAL, walletClientType: "metamask" },
      ],
    };
    await identifyPrivyUser(formo, both);
    expect(events).to.have.length(2);

    // Unlinking EXTERNAL leaves the surviving wallet's identity untouched — no
    // account-set counts are sent, so its properties are unchanged and it
    // dedupes. This is why the summary properties were dropped: had they been
    // present, every unlink would re-emit every remaining wallet.
    const one: PrivyUser = {
      id: DID,
      linkedAccounts: [
        { type: "wallet", address: EMBEDDED, walletClientType: "privy" },
      ],
    };
    await identifyPrivyUser(formo, one);
    expect(events).to.have.length(2);
  });
});
