import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: track()/page() must carry an address even when the wallet
 * never fires EIP-1193 `accountsChanged` (embedded / smart / social-login
 * wallets). The autocapture signature & transaction payload builders now
 * backfill `currentAddress` from the `from` they extract, so subsequent
 * track/page events pick it up.
 */
describe("Address backfill from autocapture", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let formo: FormoAnalytics;

  const ADDRESS_LOWER = "0x51377e9b985bb90b7c091b9a7d30c93d4c9c1cef";
  const ADDRESS_CHECKSUMMED = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const CHAIN_ID = 1;

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

  it("buildTransactionEventPayload backfills currentAddress when none is set", async () => {
    expect(formo.currentAddress).to.be.undefined;

    const mockProvider = {
      request: sandbox.stub().withArgs(sinon.match({ method: "eth_chainId" })).resolves(`0x${CHAIN_ID.toString(16)}`),
    } as any;

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS_LOWER, to: "0xabc", value: "0x0", data: "0x" }],
      mockProvider
    );

    expect(payload.address).to.equal(ADDRESS_CHECKSUMMED);
    expect(payload.chainId).to.equal(CHAIN_ID);
    // Backfill: subsequent track()/page() can now read this.
    expect(formo.currentAddress).to.equal(ADDRESS_CHECKSUMMED);
    expect(formo.currentChainId).to.equal(CHAIN_ID);
  });

  it("buildSignatureEventPayload backfills currentAddress when none is set", () => {
    expect(formo.currentAddress).to.be.undefined;

    const payload = (formo as any).buildSignatureEventPayload(
      "eth_signTypedData_v4",
      [ADDRESS_LOWER, '{"foo":"bar"}'],
      undefined,
      CHAIN_ID
    );

    expect(payload.address).to.equal(ADDRESS_CHECKSUMMED);
    expect(formo.currentAddress).to.equal(ADDRESS_CHECKSUMMED);
    expect(formo.currentChainId).to.equal(CHAIN_ID);
  });

  it("track() carries the backfilled address after an autocapture transaction", async () => {
    const addEventStub = sandbox.stub((formo as any).eventManager, "addEvent").resolves();

    const mockProvider = {
      request: sandbox.stub().withArgs(sinon.match({ method: "eth_chainId" })).resolves(`0x${CHAIN_ID.toString(16)}`),
    } as any;

    // Simulate autocapture transaction having been processed; no
    // accountsChanged was ever dispatched, so currentAddress starts empty.
    expect(formo.currentAddress).to.be.undefined;
    await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS_LOWER, to: "0xabc", value: "0x0", data: "0x" }],
      mockProvider
    );

    // Merchant app fires its custom analytics event after the wallet action.
    await formo.track("Deposit Success", { value_usd: 508 });

    expect(addEventStub.calledOnce).to.be.true;
    const [, addressArg] = addEventStub.firstCall.args;
    expect(addressArg).to.equal(ADDRESS_CHECKSUMMED);
  });

  it("does not clobber an existing connected address", async () => {
    const OTHER_ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
    await formo.connect({ chainId: CHAIN_ID, address: OTHER_ADDRESS });
    expect(formo.currentAddress).to.equal(OTHER_ADDRESS);

    const mockProvider = {
      request: sandbox.stub().withArgs(sinon.match({ method: "eth_chainId" })).resolves(`0x${CHAIN_ID.toString(16)}`),
    } as any;

    await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS_LOWER, to: "0xabc", value: "0x0", data: "0x" }],
      mockProvider
    );

    // Backfill must not overwrite the connected address.
    expect(formo.currentAddress).to.equal(OTHER_ADDRESS);
  });
});
