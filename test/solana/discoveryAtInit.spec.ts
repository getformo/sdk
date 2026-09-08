import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager, cookie } from "../../src/storage";
import { ACTIVE_WALLET_KEY } from "../../src/constants/base";
import { SOLANA_CHAIN_IDS } from "../../src/solana/types";
import { WalletStateStore } from "../../src/wallet/WalletStateStore";

/**
 * A Wallet Standard wallet injected before the SDK is reported the moment
 * discovery starts. The persisted snapshot must already be in place by then,
 * so the live connection lands on top of it and not under it.
 */
describe("Solana discovery at init", () => {
  const SNAPSHOT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // in the cookie
  const LIVE = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn"; // authorized in the wallet

  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;
  let formo: FormoAnalytics | undefined;

  const GLOBAL_KEYS = [
    "window","globalThis","document","location","navigator","localStorage","sessionStorage",
    "Event","CustomEvent","addEventListener","removeEventListener","dispatchEvent","crypto",
  ] as const;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    savedGlobals = new Map(GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://example.com" });
    for (const [k, v] of [
      ["window", jsdom.window], ["globalThis", jsdom.window], ["document", jsdom.window.document],
      ["location", jsdom.window.location], ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage], ["sessionStorage", jsdom.window.sessionStorage],
      ["Event", jsdom.window.Event], ["CustomEvent", jsdom.window.CustomEvent],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    for (const fn of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
      Object.defineProperty(global, fn, { value: (jsdom.window as any)[fn].bind(jsdom.window), writable: true, configurable: true });
    }
    Object.defineProperty(global, "crypto", { value: { randomUUID: () => "mock-uuid" }, writable: true, configurable: true });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    formo?.cleanup();
    formo = undefined;
    cookie().remove(ACTIVE_WALLET_KEY);
    sandbox.restore();
    for (const [k, d] of Array.from(savedGlobals)) {
      if (d) Object.defineProperty(global, k, d);
      else delete (global as any)[k];
    }
    jsdom.window.close();
  });

  /** A wallet already on the page: it registers when the app announces itself. */
  function injectWallet(address: string) {
    const wallet = {
      version: "1.0.0",
      name: "Phantom",
      icon: "data:image/svg+xml;base64,",
      chains: ["solana:mainnet"],
      features: { "standard:events": { version: "1.0.0", on: () => () => undefined } },
      accounts: [{ address, chains: ["solana:mainnet"] }],
    };
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as { detail?: { register(w: unknown): void } }).detail?.register(wallet);
    });
  }

  it("lets a wallet authorized before the SDK win over the persisted snapshot", async () => {
    cookie().set(ACTIVE_WALLET_KEY, JSON.stringify({ address: SNAPSHOT, chainId: SOLANA_CHAIN_IDS["mainnet-beta"] }));
    injectWallet(LIVE);
    const load = sandbox.spy(WalletStateStore.prototype, "load");
    const connect = sandbox.spy(FormoAnalytics.prototype, "connect");

    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });

    expect(connect.calledOnce, "the pre-authorized wallet is reported at init").to.be.true;
    expect(connect.firstCall.args[0].address).to.equal(LIVE);
    expect(load.calledBefore(connect), "the snapshot is in place before discovery reports").to.be.true;
    expect(formo.currentAddress, "the live connection is the active wallet").to.equal(LIVE);
    expect(formo.currentChainId).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
  });

  it("still restores the snapshot when no wallet is authorized", async () => {
    cookie().set(ACTIVE_WALLET_KEY, JSON.stringify({ address: SNAPSHOT, chainId: SOLANA_CHAIN_IDS["mainnet-beta"] }));

    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });

    expect(formo.currentAddress).to.equal(SNAPSHOT);
  });
});
