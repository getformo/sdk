import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: the provider hands the FormoAnalytics instance directly to
 * React context (value={sdk}), so useFormo consumers can destructure
 * methods (const { reset } = useFormo()). Every public IFormoAnalytics
 * method must therefore be bound in the constructor, or `this` is
 * undefined at the call site and e.g. reset() throws
 * "Cannot set property currentUserId of undefined".
 */
describe("Public method binding", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let formo: FormoAnalytics;

  beforeEach(async () => {
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

    const mockWagmiConfig = {
      subscribe: sandbox.stub().returns(() => {}),
      state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
      _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
    };
    const mockQueryClient = {
      getMutationCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
      getQueryCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
    };

    formo = await FormoAnalytics.init("test-write-key", {
      wagmi: {
        config: mockWagmiConfig as any,
        queryClient: mockQueryClient as any,
      },
    });
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

  const publicMethods = [
    "identify",
    "connect",
    "disconnect",
    "chain",
    "signature",
    "transaction",
    "detect",
    "track",
    "page",
    "reset",
    "cleanup",
    "optOutTracking",
    "optInTracking",
    "hasOptedOutTracking",
    "isAutocaptureEnabled",
    // Public on the exported class, not on IFormoAnalytics — still
    // destructurable by direct consumers of FormoAnalytics.init().
    "syncPrivyActiveChain",
    "isTrackingSuppressed",
    "getTrackedProvidersCount",
    "getProviderState",
    "syncWalletState",
  ] as const;

  publicMethods.forEach((name) => {
    it(`binds ${name} to the instance`, () => {
      expect(
        Object.prototype.hasOwnProperty.call(formo, name),
        `${name} must be bound in the constructor`
      ).to.equal(true);
      expect(
        formo[name],
        `${name} must differ from the unbound prototype method`
      ).to.not.equal(FormoAnalytics.prototype[name]);
    });
  });

  it("reset works when destructured off the instance", () => {
    formo.currentUserId = "user-1";

    const { reset } = formo;

    expect(() => reset()).to.not.throw();
    expect(formo.currentUserId).to.be.undefined;
    expect(formo.currentAddress).to.be.undefined;
    expect(formo.currentChainId).to.be.undefined;
  });

  it("hasOptedOutTracking works when destructured off the instance", () => {
    const { hasOptedOutTracking } = formo;

    expect(hasOptedOutTracking()).to.equal(false);
  });
});
