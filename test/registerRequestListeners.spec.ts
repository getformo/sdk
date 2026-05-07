import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";
import {
  WRAPPED_REQUEST_REF_SYMBOL,
  WRAPPED_REQUEST_SYMBOL,
} from "../src/types/provider";

/**
 * Regression tests for `registerRequestListeners`.
 *
 * The original bug: when the dapp's provider is a Proxy whose `get` trap
 * returns a wrapper that re-reads `target.request` on every read, installing
 * our wrapper produced an infinite synchronous cycle (RangeError: Maximum
 * call stack size exceeded), seen in @formo/analytics@1.29.0 on Samsung
 * Chrome WebView.
 */
describe("registerRequestListeners — Proxy-trapped provider safety", () => {
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

    // Use wagmi mode to skip browser-dependent provider detection; we drive
    // registerRequestListeners directly below.
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
      autocapture: { signature: true, transaction: true },
      wagmi: {
        config: mockWagmiConfig as any,
        queryClient: mockQueryClient as any,
      },
    });

    sandbox.stub(formo as any, "trackEvent").resolves();
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

  function makeProxyTrappedProvider() {
    const target: any = {
      request: async ({ method }: any) => `ok:${method}`,
      on: () => target,
      removeListener: () => target,
    };
    let current = target.request.bind(target);
    const cachedWrapper = (args: any) => current(args);
    return new Proxy(target, {
      get: (t, p) => {
        if (p === "request") return cachedWrapper;
        return (t as any)[p];
      },
      set: (t, p, v) => {
        if (p === "request") {
          current = v;
          return true;
        }
        (t as any)[p] = v;
        return true;
      },
    }) as any;
  }

  function makePlainProvider() {
    const calls: string[] = [];
    const provider: any = {
      request: async ({ method }: any) => {
        calls.push(method);
        return `ok:${method}`;
      },
      on: () => provider,
      removeListener: () => provider,
    };
    return { provider, calls };
  }

  it("does not stack-overflow on a Proxy-wrapped provider", async () => {
    const provider = makeProxyTrappedProvider();
    (formo as any).registerRequestListeners(provider);

    const result = await provider
      .request({ method: "eth_chainId", params: [] })
      .catch((e: Error) => e.message);

    expect(typeof result).to.equal("string");
    expect(result).not.to.include("call stack");
  });

  it("rejects cleanly on a second call to a Proxy-wrapped provider (counter resets)", async () => {
    const provider = makeProxyTrappedProvider();
    (formo as any).registerRequestListeners(provider);

    const first = await provider
      .request({ method: "eth_chainId", params: [] })
      .catch((e: Error) => e.message);
    const second = await provider
      .request({ method: "eth_chainId", params: [] })
      .catch((e: Error) => e.message);

    expect(typeof first).to.equal("string");
    expect(typeof second).to.equal("string");
    expect(first).not.to.include("call stack");
    expect(second).not.to.include("call stack");
  });

  it("works on a plain EIP-1193 provider (passthrough)", async () => {
    const { provider, calls } = makePlainProvider();
    (formo as any).registerRequestListeners(provider);

    const result = await provider.request({ method: "eth_chainId", params: [] });
    expect(result).to.equal("ok:eth_chainId");
    expect(calls).to.deep.equal(["eth_chainId"]);
  });

  it("is idempotent on double-wrap of the same plain provider", async () => {
    const { provider } = makePlainProvider();
    (formo as any).registerRequestListeners(provider);
    const wrappedAfterFirst = provider.request;
    (formo as any).registerRequestListeners(provider);
    expect(provider.request).to.equal(wrappedAfterFirst);
    expect((wrappedAfterFirst as any)[WRAPPED_REQUEST_SYMBOL]).to.equal(true);
  });

  it("is idempotent on re-register of a Proxy-wrapped provider (provider-level marker)", async () => {
    const provider = makeProxyTrappedProvider();
    (formo as any).registerRequestListeners(provider);
    const markerAfterFirst = provider[WRAPPED_REQUEST_REF_SYMBOL];
    expect(markerAfterFirst).to.be.a("function");
    (formo as any).registerRequestListeners(provider);
    // Second call should be a no-op via isProviderAlreadyWrapped's
    // provider-level path; the marker reference must not change.
    expect(provider[WRAPPED_REQUEST_REF_SYMBOL]).to.equal(markerAfterFirst);
  });

  it("allows 3 concurrent calls through the wrapper without tripping the guard", async () => {
    const { provider, calls } = makePlainProvider();
    (formo as any).registerRequestListeners(provider);

    const results = await Promise.all([
      provider.request({ method: "eth_blockNumber", params: [] }),
      provider.request({ method: "eth_chainId", params: [] }),
      provider.request({ method: "eth_gasPrice", params: [] }),
    ]);

    expect(results).to.deep.equal([
      "ok:eth_blockNumber",
      "ok:eth_chainId",
      "ok:eth_gasPrice",
    ]);
    expect(calls).to.have.lengthOf(3);
  });
});
