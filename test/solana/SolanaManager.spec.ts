import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { SolanaManager } from "../../src/solana/SolanaManager";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { SOLANA_CHAIN_IDS } from "../../src/solana/types";
import { SolanaClientState, SolanaClientStore } from "../../src/solana/storeTypes";
import { WalletStandardRegisterApi } from "../../src/solana/walletStandardTypes";
import { initStorageManager } from "../../src/storage";

/**
 * How the two Solana sources share one SDK.
 *
 * A framework-kit app connects THROUGH a Wallet Standard wallet, so its
 * store and the registry both witness every connection. The acceptance for
 * P-2416 is one connect per connection on every path, so this pins the
 * hand-off between them, and the `solana` option that switches discovery.
 */
describe("SolanaManager", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let mockFormo: sinon.SinonStubbedInstance<FormoAnalytics>;
  let originalGlobals: Map<PropertyKey, PropertyDescriptor | undefined>;
  const managers: SolanaManager[] = [];

  const ADDRESS = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";

  function makeStandardWallet(name: string) {
    const listeners: Array<(p: { accounts: unknown[] }) => void> = [];
    const wallet = {
      version: "1.0.0",
      name,
      icon: "data:image/svg+xml;base64,",
      chains: ["solana:mainnet", "solana:devnet"],
      features: {
        "standard:events": {
          version: "1.0.0",
          on: (_event: string, listener: (p: { accounts: unknown[] }) => void) => {
            listeners.push(listener);
            return () => {
              const idx = listeners.indexOf(listener);
              if (idx >= 0) listeners.splice(idx, 1);
            };
          },
        },
      },
      accounts: [] as unknown[],
      setAccounts(accounts: unknown[]) {
        wallet.accounts = accounts;
        for (const l of [...listeners]) l({ accounts });
      },
    };
    return wallet;
  }

  function registerStandardWallet(wallet: ReturnType<typeof makeStandardWallet>) {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", {
        detail: (api: WalletStandardRegisterApi) => api.register(wallet as never),
      })
    );
  }

  function makeStore(initial?: Partial<SolanaClientState>) {
    let state: SolanaClientState = {
      transactions: {},
      wallet: { status: "disconnected" },
      cluster: { endpoint: "https://api.devnet.solana.com", status: { status: "ready" } },
      lastUpdatedAt: Date.now(),
      ...initial,
    };
    const listeners: Array<(s: SolanaClientState, p: SolanaClientState) => void> = [];
    const store: SolanaClientStore & { setState(partial: Partial<SolanaClientState>): void } = {
      getState: () => state,
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      setState(partial) {
        const prev = state;
        state = { ...state, ...partial };
        for (const l of [...listeners]) l(state, prev);
      },
    };
    return store;
  }

  const connectedWallet = (connectorId: string, name: string) =>
    ({
      status: "connected" as const,
      connectorId,
      session: {
        account: { address: ADDRESS },
        connector: { id: connectorId, name },
        disconnect: async () => undefined,
      },
    });

  function makeManager(...args: ConstructorParameters<typeof SolanaManager> extends [unknown, ...infer R] ? R : never) {
    const manager = new SolanaManager(mockFormo as unknown as FormoAnalytics, ...args);
    managers.push(manager);
    return manager;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });
    const globals = [
      ["window", jsdom.window],
      ["globalThis", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
      ["Event", jsdom.window.Event],
      ["CustomEvent", jsdom.window.CustomEvent],
    ] as const;
    const eventMethods = [
      "addEventListener",
      "removeEventListener",
      "dispatchEvent",
    ] as const;
    const overwrittenKeys = [
      ...globals.map(([key]) => key),
      ...eventMethods,
      "crypto",
    ];
    originalGlobals = new Map(
      overwrittenKeys.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(global, key),
      ])
    );
    for (const [k, v] of globals) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    for (const fn of eventMethods) {
      Object.defineProperty(global, fn, {
        value: (jsdom.window as any)[fn].bind(jsdom.window),
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid" },
      writable: true,
      configurable: true,
    });
    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      detect: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
      willTrackEvent: sandbox.stub().returns(true),
      syncWalletState: sandbox.stub(),
    } as any;
  });

  afterEach(() => {
    while (managers.length) managers.pop()?.cleanup();
    sandbox.restore();
    for (const [key, descriptor] of Array.from(originalGlobals)) {
      if (descriptor) Object.defineProperty(global, key, descriptor);
      else delete (global as any)[key];
    }
    jsdom.window.close();
  });

  describe("without a store (wallet-adapter, Privy, Dynamic, Reown, custom)", () => {
    it("reports connect and disconnect from Wallet Standard discovery", () => {
      makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);

      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);
      phantom.setAccounts([]);

      expect(mockFormo.detect.calledOnce).to.be.true;
      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
        address: ADDRESS,
      });
      expect(mockFormo.disconnect.calledOnce).to.be.true;
    });

    it("applies a configured cluster to discovered connections", () => {
      makeManager({ cluster: "devnet" });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
    });

    it("setCluster re-tags a discovered connection", () => {
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);

      manager.setCluster("testnet");

      expect(mockFormo.chain.calledOnce).to.be.true;
      expect(mockFormo.chain.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["testnet"]);
    });

    it("lists discovered wallets", () => {
      const manager = makeManager();
      registerStandardWallet(makeStandardWallet("Phantom"));
      registerStandardWallet(makeStandardWallet("Solflare"));
      expect(manager.discoveredWallets).to.deep.equal(["Phantom", "Solflare"]);
    });
  });

  describe("with a framework-kit store", () => {
    it("emits exactly one connect when the wallet and the store both report it", () => {
      const store = makeStore();
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);

      // framework-kit connects through the standard wallet, which fires
      // `change` first; the store follows once the session resolves.
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });

      expect(mockFormo.connect.calledOnce).to.be.true;
      // The store is the witness: it knows the cluster from its endpoint.
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
      expect(mockFormo.connect.firstCall.args[1]).to.deep.equal({
        providerName: "Phantom",
        rdns: "sol.wallet.phantom",
      });
    });

    it("emits exactly one disconnect when both report it", () => {
      const store = makeStore({ wallet: connectedWallet("phantom", "Phantom") });
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      phantom.accounts = [{ address: ADDRESS, chains: ["solana:devnet"] }];
      registerStandardWallet(phantom);
      expect(mockFormo.connect.calledOnce).to.be.true;

      phantom.setAccounts([]);
      store.setState({ wallet: { status: "disconnected" } });

      expect(mockFormo.disconnect.calledOnce).to.be.true;
    });

    it("still detects wallets, which the store never reported", () => {
      makeManager({ store: makeStore() });
      registerStandardWallet(makeStandardWallet("Phantom"));
      expect(mockFormo.detect.calledOnce).to.be.true;
      expect(mockFormo.detect.firstCall.args[0].rdns).to.equal("sol.wallet.phantom");
    });

    it("hands connect reporting to a store attached later", () => {
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);

      const store = makeStore();
      manager.setStore(store);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("does not duplicate a connect observed before a connected store is attached", () => {
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);

      manager.setStore(
        makeStore({ wallet: connectedWallet("phantom", "Phantom") })
      );

      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("keeps registry ownership while a late-attached store is disconnected", () => {
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);

      manager.setStore(makeStore());
      phantom.setAccounts([]);

      expect(mockFormo.disconnect.calledOnce).to.be.true;
    });

    it("does not adopt another wallet merely because its address matches", () => {
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);

      manager.setStore(
        makeStore({ wallet: connectedWallet("solflare", "Solflare") })
      );

      expect(mockFormo.connect.callCount).to.equal(2);
      expect(mockFormo.connect.getCall(1)?.args[1]?.providerName).to.equal(
        "Solflare"
      );
    });

    it("corrects central cluster state during handoff when chain capture is off", () => {
      mockFormo.isAutocaptureEnabled.callsFake(
        (eventType) => eventType !== "chain"
      );
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);

      manager.setStore(
        makeStore({ wallet: connectedWallet("phantom", "Phantom") })
      );

      expect(
        mockFormo.syncWalletState.calledWith({
          address: ADDRESS,
          chainId: SOLANA_CHAIN_IDS.devnet,
        })
      ).to.be.true;
      expect(mockFormo.chain.called).to.be.false;
      expect(mockFormo.connect.calledOnce).to.be.true;
    });
  });

  describe("cleanup", () => {
    it("stops both sources", () => {
      const store = makeStore();
      const manager = makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);

      manager.cleanup();

      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });
      registerStandardWallet(makeStandardWallet("Solflare"));
      expect(mockFormo.connect.called).to.be.false;
      expect(mockFormo.detect.calledOnce).to.be.true;
    });
  });

  describe("the `solana` SDK option", () => {
    beforeEach(() => {
      initStorageManager("test-write-key");
    });

    /** Whether an SDK instance announced itself to Wallet Standard wallets. */
    async function announcedAppReady(options: Record<string, unknown>) {
      let announced = false;
      window.addEventListener("wallet-standard:app-ready", () => {
        announced = true;
      });
      const formo = await FormoAnalytics.init("test-write-key", { tracking: true, ...options });
      formo.cleanup();
      return announced;
    }

    it("discovers Solana wallets with no Solana configuration at all", async () => {
      expect(await announcedAppReady({})).to.be.true;
    });

    it("discovers Solana wallets in an EVM-only configuration too", async () => {
      expect(await announcedAppReady({ evm: false })).to.be.true;
    });

    it("discovers Solana wallets when a store is passed", async () => {
      expect(await announcedAppReady({ solana: { store: makeStore() } })).to.be.true;
    });

    it("does not discover when solana is false", async () => {
      expect(await announcedAppReady({ solana: false })).to.be.false;
    });

    it("does not allow setStore to bypass solana: false", async () => {
      const formo = await FormoAnalytics.init("test-write-key", {
        tracking: true,
        solana: false,
      });
      const connect = sandbox.stub(formo, "connect").resolves();
      const store = makeStore();

      formo.solana.setStore(store);
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });

      formo.cleanup();
      expect(connect.called).to.be.false;
    });

    it("reports a wallet-adapter style connection end to end", async () => {
      const formo = await FormoAnalytics.init("test-write-key", { tracking: true, evm: false });
      const connect = sandbox.stub(formo, "connect").resolves();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);
      formo.cleanup();
      expect(connect.calledOnce).to.be.true;
      expect(connect.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
        address: ADDRESS,
      });
    });
  });
});
