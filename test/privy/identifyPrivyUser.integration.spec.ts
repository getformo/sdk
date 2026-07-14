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

  const EMBEDDED = "0x1111111111111111111111111111111111111111";
  const EXTERNAL = "0x2222222222222222222222222222222222222222";
  const EXTERNAL_2 = "0x3333333333333333333333333333333333333333";
  const DID = "did:privy:integration";

  async function makeAnalytics(): Promise<FormoAnalytics> {
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
});
