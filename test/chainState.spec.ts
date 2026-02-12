import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";
import { SOLANA_CHAIN_IDS } from "../src/solana/types";

/**
 * Per-chain state isolation regression tests.
 *
 * Verifies that EVM and Solana connection state is isolated:
 * - Disconnecting one chain does not wipe the other's state
 * - `currentAddress`/`currentChainId` fall back correctly
 * - EVM disconnect payloads never contain Solana address/chainId (and vice versa)
 */
describe("Per-chain state isolation", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let formo: FormoAnalytics;

  const EVM_ADDRESS = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
  const EVM_CHAIN_ID = 1;
  const SOLANA_ADDRESS = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";
  const SOLANA_CHAIN_ID = SOLANA_CHAIN_IDS["mainnet-beta"]; // 900001

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Set up JSDOM for browser globals needed by FormoAnalytics
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

    // Use wagmi mode to skip browser-dependent provider detection.
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

    // Stub trackEvent to prevent actual API calls
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

  it("should isolate Solana disconnect from EVM state", async () => {
    // Connect EVM
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.equal(EVM_ADDRESS);
    expect(formo.currentChainId).to.equal(EVM_CHAIN_ID);

    // Connect Solana (becomes last-active)
    await formo.connect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });
    expect(formo.currentAddress).to.equal(SOLANA_ADDRESS);
    expect(formo.currentChainId).to.equal(SOLANA_CHAIN_ID);

    // Disconnect Solana — should fall back to EVM state
    await formo.disconnect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });
    expect(formo.currentAddress).to.equal(EVM_ADDRESS);
    expect(formo.currentChainId).to.equal(EVM_CHAIN_ID);
  });

  it("should isolate EVM disconnect from Solana state", async () => {
    // Connect Solana
    await formo.connect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });
    expect(formo.currentAddress).to.equal(SOLANA_ADDRESS);
    expect(formo.currentChainId).to.equal(SOLANA_CHAIN_ID);

    // Connect EVM (becomes last-active)
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.equal(EVM_ADDRESS);
    expect(formo.currentChainId).to.equal(EVM_CHAIN_ID);

    // Disconnect EVM — should fall back to Solana state
    await formo.disconnect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.equal(SOLANA_ADDRESS);
    expect(formo.currentChainId).to.equal(SOLANA_CHAIN_ID);
  });

  it("should clear all state when both chains disconnect", async () => {
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    await formo.connect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });

    await formo.disconnect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });
    await formo.disconnect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });

    expect(formo.currentAddress).to.be.undefined;
    expect(formo.currentChainId).to.be.undefined;
  });

  it("should not cross-contaminate disconnect payloads", async () => {
    const trackEventStub = (formo as any).trackEvent as sinon.SinonStub;

    // Connect both chains
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    await formo.connect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });

    trackEventStub.resetHistory();

    // Disconnect EVM explicitly
    await formo.disconnect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });

    // The disconnect trackEvent call should have EVM data, not Solana
    const disconnectCall = trackEventStub.getCall(0);
    const payload = disconnectCall.args[1]; // second arg is the payload

    if (payload.chainId) {
      expect(payload.chainId).to.equal(EVM_CHAIN_ID);
    }
    if (payload.address) {
      expect(payload.address).to.equal(EVM_ADDRESS);
    }
  });

  it("should handle re-connect after disconnect on same chain", async () => {
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    await formo.disconnect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.be.undefined;

    // Re-connect EVM
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.equal(EVM_ADDRESS);
    expect(formo.currentChainId).to.equal(EVM_CHAIN_ID);
  });

  it("should update currentAddress/currentChainId to last-active namespace", async () => {
    // Connect EVM first
    await formo.connect({ chainId: EVM_CHAIN_ID, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.equal(EVM_ADDRESS);

    // Connect Solana — becomes last-active
    await formo.connect({ chainId: SOLANA_CHAIN_ID, address: SOLANA_ADDRESS });
    expect(formo.currentAddress).to.equal(SOLANA_ADDRESS);
    expect(formo.currentChainId).to.equal(SOLANA_CHAIN_ID);

    // Re-connect EVM with new chain — becomes last-active again
    await formo.connect({ chainId: 137, address: EVM_ADDRESS });
    expect(formo.currentAddress).to.equal(EVM_ADDRESS);
    expect(formo.currentChainId).to.equal(137);
  });
});
