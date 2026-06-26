import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";

/**
 * identify() profile + label upserts.
 *
 * Verifies that identify() routes its `properties` to the user_profiles
 * datasource (via eventManager.addProfile) and its `labels` to user_labels
 * (via eventManager.addLabels), independently of the per-session identify-event
 * dedup, while still honoring the shouldTrack() gate.
 */
describe("identify() profiles & labels", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;

  const ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";

  async function makeAnalytics(): Promise<FormoAnalytics> {
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
      wagmi: { config: mockWagmiConfig as any },
    });
  }

  function stubManager(formo: FormoAnalytics) {
    const mgr = (formo as any).eventManager;
    return {
      addEvent: sandbox.stub(mgr, "addEvent").resolves(),
      addProfile: sandbox.stub(mgr, "addProfile").resolves(),
      addLabels: sandbox.stub(mgr, "addLabels").resolves(),
    };
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
    if (jsdom) jsdom.window.close();
  });

  it("upserts profile properties to user_profiles on identify", async () => {
    const formo = await makeAnalytics();
    const { addProfile } = stubManager(formo);

    await formo.identify(
      { address: ADDRESS, userId: "user-1" },
      { email: "a@b.com", plan: "pro" }
    );

    expect(addProfile.calledOnce).to.equal(true);
    const [properties, address, userId] = addProfile.firstCall.args;
    expect(properties).to.deep.equal({ email: "a@b.com", plan: "pro" });
    expect(address).to.not.be.null;
    expect(userId).to.equal("user-1");
  });

  it("upserts labels to user_labels on identify", async () => {
    const formo = await makeAnalytics();
    const { addLabels } = stubManager(formo);

    await formo.identify({
      address: ADDRESS,
      userId: "user-1",
      labels: { tier: "gold", kyc: true },
    });

    expect(addLabels.calledOnce).to.equal(true);
    const [labels] = addLabels.firstCall.args;
    expect(labels).to.deep.equal({ tier: "gold", kyc: true });
  });

  it("does not upsert when no properties or labels are given", async () => {
    const formo = await makeAnalytics();
    const { addProfile, addLabels } = stubManager(formo);

    await formo.identify({ address: ADDRESS, userId: "user-1" });

    expect(addProfile.called).to.equal(false);
    expect(addLabels.called).to.equal(false);
  });

  it("still upserts profile/labels on a repeat identify even when the identify event is deduped", async () => {
    const formo = await makeAnalytics();
    const { addEvent, addProfile, addLabels } = stubManager(formo);

    const params = {
      address: ADDRESS,
      rdns: "io.metamask",
      labels: { tier: "gold" },
    };
    await formo.identify(params, { email: "a@b.com" });
    await formo.identify(params, { email: "a@b.com" });

    // Identify event is emitted only once (session wallet dedup), but the
    // profile/label upserts fire on every call so updated state still flows.
    const identifyCalls = addEvent
      .getCalls()
      .filter((c) => c.args[0]?.type === "identify");
    expect(identifyCalls.length).to.equal(1);
    expect(addProfile.callCount).to.equal(2);
    expect(addLabels.callCount).to.equal(2);
  });

  it("does not upsert profile/labels when the user has opted out", async () => {
    const formo = await makeAnalytics();
    const { addProfile, addLabels } = stubManager(formo);
    formo.optOutTracking();

    await formo.identify(
      { address: ADDRESS, userId: "user-1", labels: { tier: "gold" } },
      { email: "a@b.com" }
    );

    expect(addProfile.called).to.equal(false);
    expect(addLabels.called).to.equal(false);
  });
});
