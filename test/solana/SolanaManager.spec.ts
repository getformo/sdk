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
import { WalletStateStore } from "../../src/wallet/WalletStateStore";
import type { Address, ChainID } from "../../src/types";

/** Let a disconnect() continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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
  /** The real wallet store the mock delegates to, so tests observe state, not calls. */
  let wallet: WalletStateStore;
  /** Every deferred restore that was attempted, whether the store accepted it or not. */
  let deferredRestores: Array<{ address: string; chainId: number }>;
  const EVM = "0x000000000000000000000000000000000000dEaD" as Address;
  let originalGlobals: Map<PropertyKey, PropertyDescriptor | undefined>;
  const managers: SolanaManager[] = [];

  const ADDRESS = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";
  const OTHER_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

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

  const connectedWallet = (connectorId: string, name: string, address: string = ADDRESS) =>
    ({
      status: "connected" as const,
      connectorId,
      session: {
        account: { address },
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
    initStorageManager("test-write-key");
    deferredRestores = [];
    wallet = new WalletStateStore({
      isPersistedIdentityPurgeRequired: () => false,
      isPageExcluded: () => false,
      isTrackingSuppressed: () => false,
      crossSubdomainCookies: () => false,
      providerChainId: () => undefined,
      onProviderDisplaced: () => undefined,
    });
    // The wallet-state methods do what FormoAnalytics does with the store,
    // minus the events, so the hand-off between registry, store handler and
    // manager is exercised against real state.
    mockFormo = {
      connect: sandbox.stub().callsFake(async (p: { chainId: ChainID; address: Address }) => {
        wallet.observe(wallet.namespaceOf(p.chainId));
        wallet.set(p.chainId, { address: p.address });
      }),
      disconnect: sandbox.stub().callsFake(async (p: { chainId: ChainID }) => {
        const ns = wallet.namespaceOf(p.chainId);
        wallet.beginDisconnect(ns);
        const before = wallet.snapshot(ns);
        await Promise.resolve(); // the event is built
        if (wallet.isUnchangedSince(ns, before)) wallet.clear(p.chainId);
      }),
      chain: sandbox.stub().callsFake(async (p: { chainId: ChainID }) => {
        wallet.set(p.chainId, {});
      }),
      detect: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
      willTrackEvent: sandbox.stub().returns(true),
      syncWalletState: sandbox.stub().callsFake((p: { chainId?: ChainID; address?: Address }) =>
        wallet.syncWalletState(p)
      ),
      restoreWalletState: sandbox.stub().callsFake((p: { chainId: ChainID; address: Address }) =>
        wallet.restore(p.chainId, p.address)
      ),
      deferWalletRestore: sandbox.stub().callsFake((chainId: ChainID) => {
        const real = wallet.deferRestore(chainId);
        return (w: { address: string; chainId: number }) => {
          deferredRestores.push(w);
          real({ chainId: w.chainId as ChainID, address: w.address as Address });
        };
      }),
    } as any;
    Object.defineProperty(mockFormo, "currentAddress", { get: () => wallet.address, configurable: true });
    Object.defineProperty(mockFormo, "solanaAddress", { get: () => wallet.solanaAddress, configurable: true });
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

  describe("without a store (Wallet Standard)", () => {
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

    it("keeps the app's cluster across setStore()", () => {
      const manager = makeManager({ store: makeStore() });
      manager.setCluster("testnet"); // named while a store is attached
      const next = makeStore(); // its endpoint says devnet
      manager.setStore(next);

      next.setState({ wallet: connectedWallet("backpack", "Backpack") });

      expect(mockFormo.connect.lastCall.args[0].chainId, "the named cluster outlives the store").to.equal(
        SOLANA_CHAIN_IDS["testnet"]
      );
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

    it("reports a connection a store given at init never observes", () => {
      const store = makeStore();
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);

      // The app connected outside framework-kit; the store stays silent.
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      expect(mockFormo.connect.calledOnce).to.be.true;

      // When the store does catch up it adopts that connect, once.
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });
      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("reports a wallet authorized before the SDK on the store's detected cluster", () => {
      // No explicit cluster: the store's devnet endpoint is the only source.
      // A wallet injected before the SDK registers the moment it hears
      // app-ready, which the registry announces from its constructor.
      const phantom = makeStandardWallet("Phantom");
      phantom.accounts = [{ address: ADDRESS, chains: ["solana:devnet"] }];
      const onReady = (e: Event) =>
        (e as CustomEvent<WalletStandardRegisterApi>).detail.register(phantom as never);
      window.addEventListener("wallet-standard:app-ready", onReady);
      try {
        makeManager({ store: makeStore() });
      } finally {
        window.removeEventListener("wallet-standard:app-ready", onReady);
      }

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS.devnet);
    });

    it("follows the store's endpoint while the registry still reports", () => {
      const store = makeStore(); // devnet
      makeManager({ store });
      store.setState({
        cluster: { endpoint: "https://api.testnet.solana.com", status: { status: "ready" } },
      });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);

      // The store never observes this connection; the registry reports it.
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:testnet"] }]);

      expect(mockFormo.connect.calledOnce).to.be.true;
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS.testnet);
    });

    it("follows a cluster change that arrives in the same store update as a wallet change", () => {
      const store = makeStore(); // devnet
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      // The registry reports Phantom while the store is still disconnected.
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet", "solana:testnet"] }]);
      expect(mockFormo.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS.devnet);

      // One batched update: the store's wallet and its endpoint change together.
      store.setState({
        wallet: connectedWallet("backpack", "Backpack"),
        cluster: { endpoint: "https://api.testnet.solana.com", status: { status: "ready" } },
      });

      // Phantom's connection is closed by the registry; it must carry the
      // cluster the registry learned from that batched update.
      phantom.setAccounts([]);
      const phantomDisconnect = mockFormo.disconnect.getCalls().find((c) => c.args[0]?.address === ADDRESS);
      expect(phantomDisconnect, "the registry closed its own connection").to.not.equal(undefined);
      expect(phantomDisconnect?.args[0]?.chainId).to.equal(SOLANA_CHAIN_IDS.testnet);
    });

    it("puts a registry connection back after the store's own wallet disconnects", async () => {
      const store = makeStore();
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      // The registry reports Phantom while the store is disconnected.
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      expect(mockFormo.connect.calledOnce).to.be.true;
      // The store then connects and later disconnects its own wallet, which
      // clears the Solana namespace.
      store.setState({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      mockFormo.restoreWalletState.resetHistory();

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      expect(deferredRestores).to.deep.equal([{ address: ADDRESS, chainId: SOLANA_CHAIN_IDS.devnet }]);
      expect(wallet.solanaAddress).to.equal(ADDRESS);
    });

    it("puts back a store wallet that was already connected when the store attached", async () => {
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]); // reported by the registry
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      manager.setStore(store); // attached while already connected
      mockFormo.restoreWalletState.resetHistory();

      phantom.setAccounts([]); // the registry closes the connection it reported
      await settle();

      expect(wallet.solanaAddress, "the initial connection is live").to.equal(OTHER_ADDRESS);
    });

    it("puts the store's wallet back after a capture-off registry clear", async () => {
      mockFormo.isAutocaptureEnabled.callsFake((t: string) => t !== "disconnect");
      const manager = makeManager();
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]); // reported by the registry
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack", ADDRESS) }); // same address, own connector
      manager.setStore(store);
      mockFormo.restoreWalletState.resetHistory();

      phantom.setAccounts([]);
      await settle();

      expect(mockFormo.restoreWalletState.lastCall?.args[0], "the store's connector is still live").to.deep.equal({
        address: ADDRESS,
        chainId: SOLANA_CHAIN_IDS.devnet,
      });
    });

    it("clears the slot the store's wallet left when disconnect capture is off", async () => {
      mockFormo.isAutocaptureEnabled.callsFake((t: string) => t !== "disconnect");
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      makeManager({ store });
      expect(wallet.solanaAddress, "the store's wallet holds the slot").to.equal(OTHER_ADDRESS);
      mockFormo.syncWalletState.resetHistory();

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      expect(mockFormo.disconnect.called, "no event with capture off").to.be.false;
      expect(mockFormo.syncWalletState.lastCall?.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS.devnet,
      });
    });

    it("hands the slot to a live registry wallet when the store's wallet leaves with capture off", async () => {
      mockFormo.isAutocaptureEnabled.callsFake((t: string) => t !== "disconnect");
      const store = makeStore();
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]); // reported by the registry
      store.setState({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      mockFormo.restoreWalletState.resetHistory();
      mockFormo.syncWalletState.resetHistory();

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      // The departed wallet is cleared first: a restore is refused while
      // tracking is suppressed and must not leave it in the slot.
      expect(mockFormo.syncWalletState.calledOnce).to.be.true;
      expect(mockFormo.syncWalletState.firstCall.args[0]).to.deep.equal({ chainId: SOLANA_CHAIN_IDS.devnet });
      expect(mockFormo.syncWalletState.calledBefore(mockFormo.restoreWalletState)).to.be.true;
      expect(mockFormo.restoreWalletState.lastCall?.args[0]).to.deep.equal({
        address: ADDRESS,
        chainId: SOLANA_CHAIN_IDS.devnet,
      });
    });

    it("does not put the departing wallet back when the registry also tracks it", async () => {
      const store = makeStore();
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      // The same wallet reaches both: the store reports it, the registry records it silently.
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      mockFormo.restoreWalletState.resetHistory();

      // The store sees the disconnect before the Wallet Standard change.
      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      const restored = mockFormo.restoreWalletState.getCalls().map((c) => c.args[0]?.address);
      expect(restored, "the departing address is not restored").to.not.include(ADDRESS);
    });

    it("puts the store's wallet back after a registry disconnect clears the namespace", async () => {
      const store = makeStore();
      makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]); // reported by the registry
      wallet.syncWalletState({ chainId: 1, address: EVM }); // an older EVM wallet sits behind
      store.setState({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      mockFormo.restoreWalletState.resetHistory();
      mockFormo.syncWalletState.resetHistory(); // count only what the disconnect writes

      phantom.setAccounts([]); // the registry closes its own connection
      await settle();

      // Through the namespace-preserving writer only: a syncWalletState()
      // here would promote the Solana wallet over the EVM one.
      expect(mockFormo.syncWalletState.called).to.be.false;
      expect(deferredRestores).to.deep.equal([{ address: OTHER_ADDRESS, chainId: SOLANA_CHAIN_IDS.devnet }]);
      expect(
        mockFormo.deferWalletRestore.calledBefore(mockFormo.disconnect),
        "the restore marker predates the disconnect"
      ).to.be.true;
      expect(wallet.solanaAddress).to.equal(OTHER_ADDRESS);
      expect(wallet.address, "Solana was active before, so it is again").to.equal(OTHER_ADDRESS);
    });

    it("does not put the store's pre-reset wallet back after a registry disconnect", async () => {
      const store = makeStore();
      const manager = makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      store.setState({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      manager.onReset(); // logout
      wallet.reset();
      mockFormo.restoreWalletState.resetHistory();

      phantom.setAccounts([]);
      await settle();

      expect(deferredRestores, "Backpack predates the reset").to.deep.equal([]);
      expect(wallet.solanaAddress).to.be.undefined;
    });

    it("does not put a pre-reset registry wallet back after the store's wallet leaves", async () => {
      const store = makeStore();
      const manager = makeManager({ store });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:devnet"] }]);
      store.setState({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      manager.onReset(); // logout, then the store's wallet leaves
      wallet.reset();
      mockFormo.restoreWalletState.resetHistory();

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      expect(deferredRestores, "Phantom predates the reset").to.deep.equal([]);
      expect(mockFormo.restoreWalletState.called).to.be.false;
      expect(wallet.solanaAddress).to.be.undefined;
    });

    it("keeps the wallet when the store reconnects the same address before its disconnect settles", async () => {
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack") });
      makeManager({ store });
      expect(wallet.solanaAddress).to.equal(ADDRESS);

      // A connector change on the same account: the handler reports a
      // disconnect and a connect in one update.
      store.setState({ wallet: connectedWallet("phantom", "Phantom") });
      await settle();

      expect(wallet.solanaAddress, "the reconnected wallet is not cleared").to.equal(ADDRESS);
      expect(wallet.address).to.equal(ADDRESS);
    });

    it("keeps central state on the store's cluster when the chain event is suppressed", async () => {
      mockFormo.isAutocaptureEnabled.callsFake((t: string) => t !== "chain");
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack") }); // devnet endpoint
      makeManager({ store });
      expect(wallet.chainId).to.equal(SOLANA_CHAIN_IDS.devnet);

      store.setState({ cluster: { endpoint: "https://api.mainnet-beta.solana.com", status: { status: "ready" } } });

      expect(mockFormo.chain.called, "no chain event with capture off").to.be.false;
      expect(wallet.chainId, "central state follows the wallet's cluster").to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      expect(wallet.solanaAddress).to.equal(ADDRESS);
    });

    it("hands the slot back as with capture off when the disconnect event fails", async () => {
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack") });
      makeManager({ store });
      mockFormo.disconnect.rejects(new Error("network"));

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      expect(wallet.solanaAddress, "the departed wallet does not stay in the slot").to.be.undefined;
    });

    it("does not re-learn a pre-reset store wallet on a cluster change", async () => {
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack") });
      const manager = makeManager({ store });
      manager.onReset(); // logout
      wallet.reset();
      mockFormo.chain.resetHistory();

      store.setState({ cluster: { endpoint: "https://api.mainnet-beta.solana.com", status: { status: "ready" } } });

      expect(wallet.solanaAddress, "identity stays clear until the wallet is observed again").to.be.undefined;
      expect(mockFormo.chain.called).to.be.false;
    });

    it("keeps an active EVM wallet when a background Solana wallet's cluster changes", async () => {
      mockFormo.isAutocaptureEnabled.callsFake((t: string) => t !== "chain");
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack") }); // devnet
      makeManager({ store });
      wallet.syncWalletState({ chainId: 1, address: EVM }); // EVM connected later: active

      store.setState({ cluster: { endpoint: "https://api.mainnet-beta.solana.com", status: { status: "ready" } } });

      expect(wallet.address, "the EVM wallet stays active").to.equal(EVM);
      expect(wallet.chainId).to.equal(1);
      expect(wallet.solanaAddress).to.equal(ADDRESS);
    });

    it("does not hand the slot to a wallet the registry only recorded", async () => {
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack") });
      makeManager({ store }); // the store owns wallet events from its first connection
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: OTHER_ADDRESS, chains: ["solana:devnet"] }]); // recorded, never reported
      expect(mockFormo.connect.calledOnce, "no connect for the recorded wallet").to.be.true;

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      expect(wallet.solanaAddress, "no connect event exists for it").to.be.undefined;
      expect(mockFormo.connect.calledOnce).to.be.true;
    });

    it("hands the slot to the newest remaining wallet when the active one leaves, with capture on", async () => {
      makeManager();
      const solflare = makeStandardWallet("Solflare");
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(solflare);
      registerStandardWallet(phantom);
      solflare.setAccounts([{ address: OTHER_ADDRESS, chains: ["solana:mainnet"] }]);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]); // active
      expect(wallet.solanaAddress).to.equal(ADDRESS);

      phantom.setAccounts([]);
      await settle();

      expect(wallet.solanaAddress, "the same outcome as with capture off").to.equal(OTHER_ADDRESS);
    });

    it("takes the restore marker before the store's disconnect is awaited", async () => {
      const store = makeStore();
      makeManager({ store });
      store.setState({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      mockFormo.deferWalletRestore.resetHistory();
      mockFormo.disconnect.resetHistory();

      store.setState({ wallet: { status: "disconnected" } });

      expect(mockFormo.deferWalletRestore.calledOnce).to.be.true;
      expect(mockFormo.deferWalletRestore.calledBefore(mockFormo.disconnect)).to.be.true;
      await settle();
    });

    it("clears a departed store wallet behind an active EVM wallet when capture is off", async () => {
      mockFormo.isAutocaptureEnabled.callsFake((t: string) => t !== "disconnect");
      const store = makeStore({ wallet: connectedWallet("backpack", "Backpack", OTHER_ADDRESS) });
      makeManager({ store });
      wallet.syncWalletState({ chainId: 1, address: EVM }); // EVM connected last
      mockFormo.syncWalletState.resetHistory();

      store.setState({ wallet: { status: "disconnected" } });
      await settle();

      expect(mockFormo.syncWalletState.lastCall?.args[0], "Solana slot cleared, EVM untouched").to.deep.equal({
        chainId: SOLANA_CHAIN_IDS.devnet,
      });
      expect(wallet.solanaAddress).to.be.undefined;
      expect(wallet.address).to.equal(EVM);
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

    it("gates later events on a Wallet Standard connection to an excluded chain", async () => {
      const formo = await FormoAnalytics.init("test-write-key", {
        tracking: { excludeChains: [SOLANA_CHAIN_IDS["mainnet-beta"]] },
        evm: false,
      });
      const sent: any[] = [];
      sandbox
        .stub((formo as any).eventManager, "addEvent")
        .callsFake(async (e: any) => {
          sent.push(e);
        });
      const phantom = makeStandardWallet("Phantom");
      registerStandardWallet(phantom);
      phantom.setAccounts([{ address: ADDRESS, chains: ["solana:mainnet"] }]);

      await formo.track("Swap Confirmed");
      formo.cleanup();

      expect(formo.currentChainId).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      expect(sent.filter((e) => e.type === "track")).to.deep.equal([]);
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
