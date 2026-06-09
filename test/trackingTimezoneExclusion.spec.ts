import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager, cookie } from "../src/storage";
import { ACTIVE_WALLET_KEY } from "../src/constants";
import type { TrackingOptions } from "../src/types";

/**
 * Timezone-based tracking opt-out.
 *
 * Verifies that `tracking.excludeTimezones` gates the single `shouldTrack()`
 * choke point that all events (page/identify/connect/track/...) flow through,
 * so visitors in an excluded timezone produce no events at all.
 */
describe("Tracking timezone exclusion", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  const originalIntl = global.Intl;

  function stubTimezone(timeZone: string) {
    Object.defineProperty(global, "Intl", {
      value: {
        DateTimeFormat: () => ({
          resolvedOptions: () => ({ timeZone }),
        }),
      },
      writable: true,
      configurable: true,
    });
  }

  async function makeAnalytics(
    tracking?: boolean | TrackingOptions
  ): Promise<FormoAnalytics> {
    // Use wagmi mode to skip browser-dependent provider detection.
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
      tracking,
      wagmi: { config: mockWagmiConfig as any },
    });
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
    delete (global as any).globalThis;
    delete (global as any).navigator;
    delete (global as any).localStorage;
    delete (global as any).sessionStorage;
    delete (global as any).crypto;
    global.Intl = originalIntl;
    if (jsdom) jsdom.window.close();
  });

  it("blocks tracking when the visitor timezone is excluded", async () => {
    stubTimezone("Europe/London");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });
    expect((formo as any).shouldTrack()).to.equal(false);
  });

  it("allows tracking when the visitor timezone is not excluded", async () => {
    stubTimezone("America/New_York");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });
    expect((formo as any).shouldTrack()).to.equal(true);
  });

  it("matches the timezone case-insensitively", async () => {
    stubTimezone("Europe/London");
    const formo = await makeAnalytics({ excludeTimezones: ["europe/london"] });
    expect((formo as any).shouldTrack()).to.equal(false);
  });

  it("allows tracking when no excludeTimezones are configured", async () => {
    stubTimezone("Europe/London");
    const formo = await makeAnalytics({});
    expect((formo as any).shouldTrack()).to.equal(true);
  });

  it("does not block when the timezone cannot be resolved", async () => {
    stubTimezone("");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });
    expect((formo as any).shouldTrack()).to.equal(true);
  });

  it("prevents identify and connect events from being enqueued", async () => {
    stubTimezone("Europe/London");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });
    const addEvent = sandbox.stub(
      (formo as any).eventManager,
      "addEvent"
    ).resolves();

    await formo.identify({
      address: "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e",
      userId: "user-1",
    });
    await formo.connect({
      chainId: 1,
      address: "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e",
    });

    expect(addEvent.called).to.equal(false);
  });

  it("does not persist wallet/identity state for an excluded visitor", async () => {
    const ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
    stubTimezone("Europe/London");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });

    await formo.identify({ address: ADDRESS, rdns: "io.metamask" });
    await formo.connect({ chainId: 1, address: ADDRESS });
    await formo.detect({ providerName: "MetaMask", rdns: "io.metamask" });

    // connect() must not have run setChainState()
    expect(formo.currentAddress).to.not.equal(ADDRESS);
    expect(formo.currentChainId).to.be.oneOf([undefined, null]);
    // identify()/detect() must not have written session markers
    const session = (formo as any).session;
    expect(session.isWalletIdentified(ADDRESS, "io.metamask")).to.equal(false);
    expect(session.isWalletDetected("io.metamask")).to.equal(false);
  });

  it("does not persist an active-wallet cookie via the autocapture/sync path", async () => {
    const ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
    stubTimezone("Europe/London");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });

    // syncWalletState() is the entry point used by the EIP-1193 and Wagmi
    // autocapture handlers; it updates chain state directly, bypassing the
    // gated public connect(). The persistence guard must still suppress the
    // active-wallet cookie for a suppressed visitor.
    formo.syncWalletState({ chainId: 1, address: ADDRESS });

    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });

  it("persists an active-wallet cookie for a non-excluded visitor (control)", async () => {
    const ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
    stubTimezone("America/New_York");
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });

    formo.syncWalletState({ chainId: 1, address: ADDRESS });

    expect(cookie().get(ACTIVE_WALLET_KEY)).to.be.ok;
  });

  // --- Host / path (current-page) suppression ---------------------------------

  const ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";

  function navigateTo(url: string) {
    jsdom.reconfigure({ url });
  }

  it("does not track or persist while on an excluded host", async () => {
    navigateTo("https://staging.example.com/");
    const formo = await makeAnalytics({ excludeHosts: ["staging.example.com"] });

    expect((formo as any).shouldTrack()).to.equal(false);
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });

  it("does not track or persist while on an excluded path", async () => {
    navigateTo("https://example.com/admin");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });

    expect((formo as any).shouldTrack()).to.equal(false);
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });

  it("does not delete an existing cookie when navigating onto an excluded path", async () => {
    // Connect on an allowed path → cookie written.
    navigateTo("https://example.com/");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.be.ok;

    // Navigate onto the excluded path → cookie must survive (no new write,
    // but no destructive delete either).
    navigateTo("https://example.com/admin");
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.be.ok;
  });

  it("resumes tracking after navigating from an excluded path to an allowed one", async () => {
    navigateTo("https://example.com/admin");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });
    expect((formo as any).shouldTrack()).to.equal(false);

    navigateTo("https://example.com/dashboard");
    expect((formo as any).shouldTrack()).to.equal(true);
  });

  it("clears stale identity when a disconnect is observed on an excluded path", async () => {
    // Learn wallet A on an allowed path.
    navigateTo("https://example.com/");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(formo.currentAddress).to.equal(ADDRESS);
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.be.ok;

    // Disconnect observed while on the excluded path must clear the stale
    // wallet (memory + cookie), not leave it for later allowed events.
    navigateTo("https://example.com/admin");
    formo.syncWalletState({ chainId: 1 });
    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;

    // Back on an allowed path the stale address must not reappear.
    navigateTo("https://example.com/dashboard");
    expect((formo as any).shouldTrack()).to.equal(true);
    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
  });

  it("clears stale identity when a wallet switch is observed on an excluded path", async () => {
    const ADDRESS_B = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
    navigateTo("https://example.com/");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(formo.currentAddress).to.equal(ADDRESS);

    // A switch to a different wallet on the excluded path must drop the stale
    // wallet without learning the new one.
    navigateTo("https://example.com/admin");
    formo.syncWalletState({ chainId: 1, address: ADDRESS_B });
    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });

  it("does not write session markers via identify/detect on an excluded path", async () => {
    navigateTo("https://example.com/admin");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });

    await formo.identify({ address: ADDRESS, rdns: "io.metamask" });
    await formo.detect({ providerName: "MetaMask", rdns: "io.metamask" });

    const session = (formo as any).session;
    expect(session.isWalletIdentified(ADDRESS, "io.metamask")).to.equal(false);
    expect(session.isWalletDetected("io.metamask")).to.equal(false);
  });

  it("does not restore the active-wallet snapshot at init on an excluded path, but keeps the cookie", async () => {
    // Seed a snapshot as if written on a previous allowed-page visit.
    cookie().set(ACTIVE_WALLET_KEY, JSON.stringify({ address: ADDRESS, chainId: 1 }), {
      path: "/",
    });
    navigateTo("https://example.com/admin");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });

    // Not restored into memory while on the excluded route...
    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
    // ...but the cookie is preserved for a later allowed-page load.
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.be.ok;
  });

  it("purges the active-wallet snapshot at init for an excluded-timezone visitor", async () => {
    stubTimezone("Europe/London");
    cookie().set(ACTIVE_WALLET_KEY, JSON.stringify({ address: ADDRESS, chainId: 1 }), {
      path: "/",
    });
    const formo = await makeAnalytics({ excludeTimezones: ["Europe/London"] });

    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });

  it("does not learn identity via backfillActiveWallet while on an excluded path", async () => {
    // backfillActiveWallet() is the shared sink for the autocapture
    // signature/transaction paths; a signature/transaction observed on an
    // excluded route must not populate currentAddress.
    navigateTo("https://example.com/admin");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });

    (formo as any).backfillActiveWallet(ADDRESS, 1);

    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });

  it("backfills identity via backfillActiveWallet on an allowed path (control)", async () => {
    navigateTo("https://example.com/");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });

    (formo as any).backfillActiveWallet(ADDRESS, 1);

    expect(formo.currentAddress).to.equal(ADDRESS);
  });

  it("drops a stale EVM wallet on switch via the suppressed autocapture helper", async () => {
    // Helper shared by the EIP-1193 onAccountsChanged / onConnected listeners.
    const ADDRESS_B = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
    navigateTo("https://example.com/");
    const formo = await makeAnalytics({ excludePaths: ["/admin"] });
    formo.syncWalletState({ chainId: 1, address: ADDRESS });
    expect(formo.currentAddress).to.equal(ADDRESS);

    navigateTo("https://example.com/admin");
    (formo as any).clearStaleEvmWalletOnSwitchWhileSuppressed(ADDRESS_B);

    expect(formo.currentAddress).to.be.oneOf([undefined, null]);
    expect(cookie().get(ACTIVE_WALLET_KEY)).to.not.be.ok;
  });
});
