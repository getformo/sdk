import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";
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
    delete (global as any).Intl;
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
});
