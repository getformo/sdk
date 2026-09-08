import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import {
  SolanaWalletStandardRegistry,
  SolanaWalletStandardRegistryDeps,
} from "../../src/solana/SolanaWalletStandardRegistry";
import { SOLANA_CHAIN_IDS } from "../../src/solana/types";
import {
  WalletStandardAccount,
  WalletStandardChangeProperties,
  WalletStandardRegisterApi,
} from "../../src/solana/walletStandardTypes";

/**
 * Solana wallet discovery through the Wallet Standard.
 *
 * Regression for P-2416: a Wallet Standard app produced no Solana connect
 * events because the only autocapture path was framework-kit's store.
 * Compatible Solana wallets announce themselves through the Wallet Standard,
 * so observing that covers them all.
 */
describe("SolanaWalletStandardRegistry", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let deps: sinon.SinonStubbedInstance<SolanaWalletStandardRegistryDeps>;
  let ownsWalletEvents: boolean;
  let autocapture: Record<string, boolean>;
  let willTrack: boolean;
  let currentAddress: string | undefined;
  /** The Solana slot, when it differs from what currentAddress implies. */
  let solanaSlot: string | undefined;
  let originalGlobals: Map<PropertyKey, PropertyDescriptor | undefined>;
  const registries: SolanaWalletStandardRegistry[] = [];

  const ADDRESS = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";
  const OTHER_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const EVM = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";

  type FakeWallet = {
    version: string;
    name: string;
    icon: string;
    chains: string[];
    features: Record<string, unknown>;
    accounts: WalletStandardAccount[];
    /** Set the authorized accounts and fire `change`, as a real wallet does. */
    setAccounts(accounts: WalletStandardAccount[]): void;
    /** Fire `change` with arbitrary properties. */
    emit(properties: WalletStandardChangeProperties): void;
    listenerCount(): number;
  };

  function account(
    address: string,
    chains: string[] | undefined = ["solana:mainnet", "solana:devnet"]
  ): WalletStandardAccount {
    return { address, publicKey: new Uint8Array(32), chains, features: [] };
  }

  function makeWallet(
    name: string,
    options: { chains?: string[]; accounts?: WalletStandardAccount[]; events?: boolean } = {}
  ): FakeWallet {
    const listeners: Array<(p: WalletStandardChangeProperties) => void> = [];
    const wallet: FakeWallet = {
      version: "1.0.0",
      name,
      icon: "data:image/svg+xml;base64,",
      chains: options.chains ?? ["solana:mainnet", "solana:devnet", "solana:testnet"],
      features: {},
      accounts: options.accounts ?? [],
      setAccounts(accounts) {
        wallet.accounts = accounts;
        wallet.emit({ accounts });
      },
      emit(properties) {
        for (const listener of [...listeners]) listener(properties);
      },
      listenerCount: () => listeners.length,
    };
    if (options.events !== false) {
      wallet.features["standard:events"] = {
        version: "1.0.0",
        on: (event: string, listener: (p: WalletStandardChangeProperties) => void) => {
          if (event !== "change") return () => undefined;
          listeners.push(listener);
          return () => {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
      };
    }
    return wallet;
  }

  /** What a wallet extension does when the page announces itself. */
  function installWalletBeforeApp(wallet: FakeWallet): void {
    window.addEventListener("wallet-standard:app-ready", (event) => {
      (event as unknown as { detail: WalletStandardRegisterApi }).detail.register(
        wallet as never
      );
    });
  }

  /** What a wallet extension does when it is injected after the page. */
  function installWalletAfterApp(wallet: FakeWallet): void {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", {
        detail: (api: WalletStandardRegisterApi) => api.register(wallet as never),
      })
    );
  }

  function makeRegistry(options?: { cluster?: "mainnet-beta" | "devnet" | "testnet" | "localnet" }) {
    const registry = new SolanaWalletStandardRegistry(deps, options);
    registries.push(registry);
    return registry;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });
    const globals = [
      ["window", jsdom.window],
      ["document", jsdom.window.document],
      ["Event", jsdom.window.Event],
      ["CustomEvent", jsdom.window.CustomEvent],
    ] as const;
    originalGlobals = new Map(
      globals.map(([key]) => [key, Object.getOwnPropertyDescriptor(global, key)])
    );
    for (const [k, v] of globals) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    ownsWalletEvents = true;
    autocapture = {};
    willTrack = true;
    currentAddress = undefined;
    solanaSlot = undefined;
    deps = {
      isAutocaptureEnabled: sandbox.stub().callsFake((t: string) => autocapture[t] !== false),
      willTrackEvent: sandbox.stub().callsFake(() => willTrack),
      detect: sandbox.stub().resolves(),
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      syncWalletState: sandbox.stub(),
      restoreWalletState: sandbox.stub(),
      // The deferred writer is the same stub, so restores assert in one place.
      deferWalletRestore: sandbox.stub().callsFake(() => deps.restoreWalletState),
      currentAddress: sandbox.stub().callsFake(() => currentAddress),
      // The Solana slot: an explicit override, else currentAddress when it is a Solana address.
      solanaAddress: sandbox
        .stub()
        .callsFake(() => solanaSlot ?? (currentAddress && !currentAddress.startsWith("0x") ? currentAddress : undefined)),
      ownsWalletEvents: sandbox.stub().callsFake(() => ownsWalletEvents),
    } as unknown as typeof deps;
  });

  afterEach(() => {
    while (registries.length) registries.pop()?.cleanup();
    sandbox.restore();
    for (const [key, descriptor] of Array.from(originalGlobals)) {
      if (descriptor) Object.defineProperty(global, key, descriptor);
      else delete (global as any)[key];
    }
    jsdom.window.close();
  });

  // ── discovery ────────────────────────────────────────────────────────────

  describe("discovery", () => {
    it("detects a wallet that was injected before the SDK (app-ready)", () => {
      installWalletBeforeApp(makeWallet("Phantom"));
      makeRegistry();
      expect(deps.detect.calledOnce).to.be.true;
      expect(deps.detect.firstCall.args[0]).to.deep.equal({
        providerName: "Phantom",
        rdns: "sol.wallet.phantom",
      });
    });

    it("detects a wallet that is injected after the SDK (register-wallet)", () => {
      const registry = makeRegistry();
      expect(deps.detect.called).to.be.false;
      installWalletAfterApp(makeWallet("Solflare"));
      expect(deps.detect.calledOnce).to.be.true;
      expect(deps.detect.firstCall.args[0].providerName).to.equal("Solflare");
      expect(registry.walletNames).to.deep.equal(["Solflare"]);
    });

    it("derives the rdns the same way as the framework-kit store handler", () => {
      installWalletAfterApp(makeWallet("Magic Eden Wallet"));
      makeRegistry();
      installWalletAfterApp(makeWallet("Magic Eden Wallet"));
      expect(deps.detect.firstCall.args[0].rdns).to.equal(
        "sol.wallet.magicedenwallet"
      );
    });

    it("preserves the historical lowercase, whitespace-free rdns", () => {
      makeRegistry();
      installWalletAfterApp(makeWallet("Magic Wallet"));
      installWalletAfterApp(makeWallet("magicwallet"));

      expect(deps.detect.callCount).to.equal(2);
      expect(deps.detect.firstCall.args[0].rdns).to.equal(
        "sol.wallet.magicwallet"
      );
      expect(deps.detect.secondCall.args[0].rdns).to.equal(
        "sol.wallet.magicwallet"
      );
    });

    it("encodes cookie delimiters after normalizing the wallet name", () => {
      makeRegistry();
      installWalletAfterApp(makeWallet("Comma, Wallet"));

      expect(deps.detect.firstCall.args[0].rdns).to.equal(
        "sol.wallet.comma%2Cwallet"
      );
    });

    it("registers each wallet object once", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      installWalletAfterApp(wallet);
      expect(deps.detect.calledOnce).to.be.true;
      expect(wallet.listenerCount()).to.equal(1);
    });

    it("ignores a wallet that lists no Solana chain", () => {
      const registry = makeRegistry();
      installWalletAfterApp(makeWallet("EVM Only", { chains: ["eip155:1"] }));
      expect(deps.detect.called).to.be.false;
      expect(registry.walletNames).to.deep.equal([]);
    });

    it("tracks a multichain wallet that lists Solana beside other namespaces", () => {
      makeRegistry();
      installWalletAfterApp(
        makeWallet("Backpack", { chains: ["eip155:1", "solana:mainnet"] })
      );
      expect(deps.detect.calledOnce).to.be.true;
    });

    it("ignores registrations that are not wallets", () => {
      const registry = makeRegistry();
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: (api: WalletStandardRegisterApi) =>
            api.register(null as never, "nope" as never, { name: "x" } as never),
        })
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", { detail: "not a callback" })
      );
      expect(deps.detect.called).to.be.false;
      expect(registry.walletNames).to.deep.equal([]);
    });

    it("survives a wallet that throws while registering", () => {
      makeRegistry();
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: () => {
            throw new Error("wallet bug");
          },
        })
      );
      installWalletAfterApp(makeWallet("Phantom"));
      expect(deps.detect.calledOnce).to.be.true;
    });

    it("still detects a wallet without a standard:events feature", () => {
      makeRegistry();
      installWalletAfterApp(makeWallet("Old Wallet", { events: false }));
      expect(deps.detect.calledOnce).to.be.true;
      expect(deps.connect.called).to.be.false;
    });

    it("constructs without a window (SSR) and does nothing", () => {
      delete (global as any).window;
      expect(() => makeRegistry()).to.not.throw();
      expect(deps.detect.called).to.be.false;
    });
  });

  // ── connect / disconnect ─────────────────────────────────────────────────

  describe("connections", () => {
    it("emits connect when a wallet's accounts go from none to some", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      expect(deps.connect.called).to.be.false;

      wallet.setAccounts([account(ADDRESS)]);

      expect(deps.connect.calledOnce).to.be.true;
      expect(deps.connect.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
        address: ADDRESS,
      });
      expect(deps.connect.firstCall.args[1]).to.deep.equal({
        providerName: "Phantom",
        rdns: "sol.wallet.phantom",
      });
    });

    it("emits disconnect when accounts go from some to none", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);

      wallet.setAccounts([]);

      expect(deps.disconnect.calledOnce).to.be.true;
      expect(deps.disconnect.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
        address: ADDRESS,
      });
    });

    it("emits disconnect then connect on an account switch", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);

      wallet.setAccounts([account(OTHER)]);

      expect(deps.disconnect.calledOnce).to.be.true;
      expect(deps.disconnect.firstCall.args[0].address).to.equal(ADDRESS);
      expect(deps.connect.calledTwice).to.be.true;
      expect(deps.connect.secondCall.args[0].address).to.equal(OTHER);
      expect(deps.disconnect.firstCall.calledBefore(deps.connect.secondCall)).to.be.true;
    });

    it("emits exactly one connect for one connection", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      // A wallet may re-announce the same accounts (chains or features changed).
      wallet.emit({ accounts: [account(ADDRESS)] });
      wallet.emit({ chains: ["solana:mainnet"] });
      expect(deps.connect.calledOnce).to.be.true;
      expect(deps.disconnect.called).to.be.false;
    });

    it("reads the wallet's own accounts when a change event omits them", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.accounts = [account(ADDRESS)];
      wallet.emit({});
      expect(deps.connect.calledOnce).to.be.true;
    });

    it("emits connect for a wallet that is already authorized when discovered", () => {
      makeRegistry();
      installWalletAfterApp(makeWallet("Phantom", { accounts: [account(ADDRESS)] }));
      expect(deps.detect.calledOnce).to.be.true;
      expect(deps.connect.calledOnce).to.be.true;
      expect(deps.connect.firstCall.args[0].address).to.equal(ADDRESS);
    });

    it("does not emit twice for a wallet that is authorized both before and after discovery", () => {
      const wallet = makeWallet("Phantom", { accounts: [account(ADDRESS)] });
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      expect(deps.connect.calledOnce).to.be.true;
    });

    it("skips non-Solana accounts on a multichain wallet", () => {
      const wallet = makeWallet("Backpack", { chains: ["eip155:1", "solana:mainnet"] });
      makeRegistry();
      installWalletAfterApp(wallet);

      wallet.setAccounts([account(EVM, ["eip155:1"])]);
      expect(deps.connect.called).to.be.false;

      wallet.setAccounts([account(EVM, ["eip155:1"]), account(ADDRESS, ["solana:mainnet"])]);
      expect(deps.connect.calledOnce).to.be.true;
      expect(deps.connect.firstCall.args[0].address).to.equal(ADDRESS);
    });

    it("judges an account with no chain list on its address alone", () => {
      const wallet = makeWallet("Minimal");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(EVM, undefined)]);
      expect(deps.connect.called).to.be.false;
      wallet.setAccounts([account(ADDRESS, undefined)]);
      expect(deps.connect.calledOnce).to.be.true;
    });

    it("ignores system program addresses", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(SYSTEM_PROGRAM)]);
      expect(deps.connect.called).to.be.false;
    });

    it("tracks two wallets independently", () => {
      const phantom = makeWallet("Phantom");
      const solflare = makeWallet("Solflare");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(solflare);

      phantom.setAccounts([account(ADDRESS)]);
      solflare.setAccounts([account(OTHER)]);
      phantom.setAccounts([]);

      expect(deps.connect.calledTwice).to.be.true;
      expect(deps.disconnect.calledOnce).to.be.true;
      expect(deps.disconnect.firstCall.args[0].address).to.equal(ADDRESS);
    });

    it("respects autocapture switches for connect and disconnect", () => {
      autocapture = { connect: false, disconnect: false };
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      wallet.setAccounts([]);
      expect(deps.connect.called).to.be.false;
      expect(deps.disconnect.called).to.be.false;
    });

    it("records central state when connect capture is off", () => {
      autocapture = { connect: false };
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);

      wallet.setAccounts([account(ADDRESS)]);

      expect(deps.connect.called).to.be.false;
      expect(
        deps.syncWalletState.calledWith({
          chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
          address: ADDRESS,
        })
      ).to.be.true;
    });

    it("records central state for a connection on an excluded chain", () => {
      willTrack = false;
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);

      wallet.setAccounts([account(ADDRESS)]);

      // Exclusion is not suppression: the chain gate keys off central
      // state, so the excluded chain must land there.
      expect(deps.connect.called).to.be.false;
      expect(
        deps.syncWalletState.calledWith({
          chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
          address: ADDRESS,
        })
      ).to.be.true;
    });

    it("clears central state when disconnect capture is off", () => {
      autocapture = { disconnect: false };
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);

      wallet.setAccounts([]);

      expect(deps.disconnect.called).to.be.false;
      expect(deps.syncWalletState.lastCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("leaves central state alone when a non-active wallet disconnects with capture off", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = OTHER_ADDRESS; // the SDK treats the last connected wallet as active
      deps.syncWalletState.resetHistory();

      phantom.setAccounts([]);

      expect(deps.disconnect.called).to.be.false;
      expect(deps.syncWalletState.called, "the active wallet keeps the slot").to.be.false;
    });

    it("hands central state to a wallet still connected when the active one disconnects with capture off", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = OTHER_ADDRESS;

      backpack.setAccounts([]);

      expect(deps.disconnect.called).to.be.false;
      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        address: ADDRESS,
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("clears the Solana slot on a suppressed disconnect even while an EVM wallet is active", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(phantom);
      phantom.setAccounts([account(ADDRESS)]);
      currentAddress = "0x000000000000000000000000000000000000dEaD"; // EVM wallet took the active slot
      deps.syncWalletState.resetHistory();

      phantom.setAccounts([]);

      expect(deps.syncWalletState.lastCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("does not put back a wallet connected before reset()", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      const registry = makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      registry.onReset(); // logout: both connections predate the clean slate
      currentAddress = OTHER_ADDRESS; // Backpack still sits in the slot
      deps.restoreWalletState.resetHistory();
      deps.syncWalletState.resetHistory();

      backpack.setAccounts([]);

      expect(deps.restoreWalletState.called, "Phantom predates the reset").to.be.false;
      expect(deps.syncWalletState.lastCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
      expect(registry.newestConnection()).to.be.undefined;
    });

    it("follows the newest Solana connection on a cluster switch while an EVM wallet is active", () => {
      autocapture.chain = false;
      const phantom = makeWallet("Phantom");
      const solflare = makeWallet("Solflare");
      const registry = makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(solflare);
      phantom.setAccounts([account(ADDRESS)]);
      solflare.setAccounts([account(OTHER_ADDRESS)]); // connected last
      currentAddress = "0x000000000000000000000000000000000000dEaD"; // EVM active, Solana slot dormant
      solanaSlot = undefined;
      deps.restoreWalletState.resetHistory();

      registry.setCluster("devnet");

      expect(deps.restoreWalletState.calledOnce).to.be.true;
      expect(deps.restoreWalletState.firstCall.args[0], "connection order, not registration order").to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["devnet"],
        address: OTHER_ADDRESS,
      });
    });

    it("puts back a second wallet connected on the same address", async () => {
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(ADDRESS)]); // same account, distinct wallet
      currentAddress = ADDRESS;
      deps.disconnect.callsFake(async () => {
        currentAddress = undefined;
      });
      deps.restoreWalletState.resetHistory();

      phantom.setAccounts([]);
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.restoreWalletState.lastCall?.args[0], "Backpack still holds the account").to.deep.equal({
        address: ADDRESS,
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("does not hand the slot to a pre-reset wallet on a cluster switch", () => {
      const phantom = makeWallet("Phantom");
      const registry = makeRegistry();
      installWalletAfterApp(phantom);
      phantom.setAccounts([account(ADDRESS)]);
      registry.onReset();
      currentAddress = undefined; // reset() emptied the slot
      deps.restoreWalletState.resetHistory();

      registry.setCluster("devnet");

      expect(deps.restoreWalletState.called, "Phantom predates the reset").to.be.false;
    });

    it("puts back a wallet observed again after reset()", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      const registry = makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      registry.onReset();
      backpack.setAccounts([account(OTHER_ADDRESS)]); // a fresh observation
      phantom.setAccounts([]);
      phantom.setAccounts([account(ADDRESS)]); // Phantom reconnects: eligible again
      currentAddress = ADDRESS;
      deps.restoreWalletState.resetHistory();

      phantom.setAccounts([]);

      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        address: OTHER_ADDRESS,
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("hands the Solana slot to a remaining wallet without displacing an active EVM wallet", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = "0x000000000000000000000000000000000000dEaD"; // EVM connected last
      solanaSlot = OTHER_ADDRESS; // Backpack holds the Solana slot behind it
      deps.syncWalletState.resetHistory();

      backpack.setAccounts([]);

      // The departed wallet is cleared first (a restore is a no-op while
      // suppressed), then a namespace-preserving restore, never a
      // promoting sync with an address.
      expect(deps.syncWalletState.calledOnce).to.be.true;
      expect(deps.syncWalletState.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
      expect(deps.syncWalletState.calledBefore(deps.restoreWalletState)).to.be.true;
      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        address: ADDRESS,
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("hands the slot to the most recently connected remaining wallet", () => {
      autocapture = { disconnect: false };
      const a = makeWallet("A");
      const b = makeWallet("B");
      const c = makeWallet("C");
      makeRegistry();
      installWalletAfterApp(a);
      installWalletAfterApp(b);
      installWalletAfterApp(c);
      a.setAccounts([account(ADDRESS)]);
      b.setAccounts([account(OTHER_ADDRESS)]);
      const THIRD = "So11111111111111111111111111111111111111112";
      c.setAccounts([account(THIRD)]);
      currentAddress = THIRD;

      c.setAccounts([]);

      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        address: OTHER_ADDRESS,
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("emits the disconnect for a connection it reported before a store took ownership", () => {
      const phantom = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(phantom);
      phantom.setAccounts([account(ADDRESS)]);
      expect(deps.connect.calledOnce).to.be.true;

      ownsWalletEvents = false; // a store connected another wallet meanwhile
      phantom.setAccounts([]);

      expect(deps.disconnect.calledOnce).to.be.true;
      expect(deps.disconnect.firstCall.args[0].address).to.equal(ADDRESS);
    });

    it("leaves a wallet it does not track to its owner after closing a reported connection", async () => {
      const phantom = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(phantom);
      phantom.setAccounts([account(ADDRESS)]);
      expect(deps.connect.calledOnce).to.be.true;
      // A store connected another wallet; it holds the Solana slot now.
      ownsWalletEvents = false;
      currentAddress = OTHER_ADDRESS;
      deps.disconnect.callsFake(async () => {
        currentAddress = undefined; // disconnect() cleared the namespace
      });
      deps.syncWalletState.resetHistory();

      phantom.setAccounts([]);
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.disconnect.calledOnce, "the reported connection is closed").to.be.true;
      expect(deps.syncWalletState.called, "the store restores its own wallet, not the registry").to.be.false;
      expect(deps.restoreWalletState.called).to.be.false;
    });

    it("does not restore a tracked wallet that disconnected while the first disconnect was in flight", async () => {
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = OTHER_ADDRESS;
      const resolvers: Array<() => void> = [];
      deps.disconnect.callsFake(() => new Promise<void>((r) => { resolvers.push(r); }));
      deps.restoreWalletState.resetHistory();

      phantom.setAccounts([]);   // keeps Backpack in mind (first resolver)
      backpack.setAccounts([]);  // but Backpack leaves too before Phantom's disconnect settles
      currentAddress = undefined; // both disconnects cleared the namespace
      for (const r of resolvers) r();
      await new Promise((r) => setTimeout(r, 0));

      expect(resolvers.length, "both disconnects were emitted").to.equal(2);
      expect(deps.restoreWalletState.called, "a departed wallet is not put back").to.be.false;
    });

    it("does not overwrite a wallet that connected while the disconnect was in flight", async () => {
      const phantom = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(phantom);
      phantom.setAccounts([account(ADDRESS)]);
      ownsWalletEvents = false;
      currentAddress = OTHER_ADDRESS; // a store's wallet holds the slot
      const NEWER = "So11111111111111111111111111111111111111112";
      deps.disconnect.callsFake(async () => {
        currentAddress = NEWER; // another wallet took the slot meanwhile
      });
      deps.syncWalletState.resetHistory();

      phantom.setAccounts([]);
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.syncWalletState.called, "the newer wallet keeps the slot").to.be.false;
    });

    it("takes the restore marker before the disconnect is awaited", async () => {
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = OTHER_ADDRESS;
      deps.deferWalletRestore.resetHistory();
      deps.disconnect.resetHistory();

      phantom.setAccounts([]);

      // Synchronously, before disconnect() resolves: a reset() landing in
      // between is what the marker exists to catch.
      expect(deps.deferWalletRestore.calledOnce).to.be.true;
      expect(deps.deferWalletRestore.calledBefore(deps.disconnect)).to.be.true;
      expect(deps.deferWalletRestore.firstCall.args[0]).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
      await new Promise((r) => setTimeout(r, 0));
    });

    it("restores a tracked wallet into the empty Solana slot even when an EVM wallet is active", async () => {
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = OTHER_ADDRESS;
      deps.disconnect.callsFake(async () => {
        currentAddress = "0x000000000000000000000000000000000000dEaD"; // EVM fallback after the clear
        solanaSlot = undefined;
      });
      deps.syncWalletState.resetHistory();

      phantom.setAccounts([]);
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.syncWalletState.called, "never a promoting sync").to.be.false;
      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        address: OTHER_ADDRESS,
        chainId: SOLANA_CHAIN_IDS["mainnet-beta"],
      });
    });

    it("restores a retained wallet with the chain it is on once the disconnect settles", async () => {
      const phantom = makeWallet("Phantom");
      const backpack = makeWallet("Backpack");
      const registry = makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(backpack);
      phantom.setAccounts([account(ADDRESS)]);
      backpack.setAccounts([account(OTHER_ADDRESS)]);
      currentAddress = OTHER_ADDRESS;
      deps.disconnect.callsFake(async () => {
        registry.setCluster("devnet"); // the cluster moves while the event is in flight
        currentAddress = undefined;
      });
      deps.restoreWalletState.resetHistory();

      phantom.setAccounts([]);
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS.devnet,
        address: OTHER_ADDRESS,
      });
    });

    it("restores a tracked wallet with the chain it connected on", async () => {
      const phantom = makeWallet("Phantom");
      const devnetOnly = makeWallet("DevnetOnly", { chains: ["solana:devnet"] });
      makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(devnetOnly);
      phantom.setAccounts([account(ADDRESS)]);
      devnetOnly.setAccounts([account(OTHER_ADDRESS, ["solana:devnet"])]);
      currentAddress = OTHER_ADDRESS;
      deps.disconnect.callsFake(async () => {
        currentAddress = undefined;
      });
      deps.restoreWalletState.resetHistory();

      phantom.setAccounts([]);
      await new Promise((r) => setTimeout(r, 0));

      expect(deps.restoreWalletState.lastCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS.devnet,
        address: OTHER_ADDRESS,
      });
    });

    it("leaves a store-owned Solana wallet alone on a suppressed disconnect", () => {
      autocapture = { disconnect: false };
      const phantom = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(phantom);
      phantom.setAccounts([account(ADDRESS)]);
      currentAddress = OTHER_ADDRESS; // a store's wallet, unknown to the registry
      deps.syncWalletState.resetHistory();

      phantom.setAccounts([]);

      expect(deps.syncWalletState.called).to.be.false;
    });

    it("does not mark a suppressed connect as reported for store handoff", () => {
      const wallet = makeWallet("Phantom");
      const registry = makeRegistry();
      installWalletAfterApp(wallet);
      willTrack = false;

      wallet.setAccounts([account(ADDRESS)]);

      expect(
        registry.takeReportedConnection(ADDRESS, "sol.wallet.phantom")
      ).to.equal(undefined);
    });

    it("keeps reporting after a rejected emit", () => {
      deps.connect.onFirstCall().rejects(new Error("network"));
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      wallet.setAccounts([]);
      wallet.setAccounts([account(ADDRESS)]);
      expect(deps.connect.calledTwice).to.be.true;
      expect(deps.disconnect.calledOnce).to.be.true;
    });
  });

  // ── framework-kit coexistence ────────────────────────────────────────────

  describe("when a framework-kit store owns wallet events", () => {
    beforeEach(() => {
      ownsWalletEvents = false;
    });

    it("still emits detect but leaves connect and disconnect to the store", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      wallet.setAccounts([]);
      expect(deps.detect.calledOnce).to.be.true;
      expect(deps.connect.called).to.be.false;
      expect(deps.disconnect.called).to.be.false;
    });

    it("keeps its own picture of the connection so ownership can change", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      expect(deps.connect.called).to.be.false;

      // The store handler goes away; the next transition is ours to report,
      // and it is judged against the connection the store reported.
      ownsWalletEvents = true;
      wallet.setAccounts([]);
      expect(deps.disconnect.calledOnce).to.be.true;
      expect(deps.disconnect.firstCall.args[0].address).to.equal(ADDRESS);
    });
  });

  // ── cluster ──────────────────────────────────────────────────────────────

  describe("cluster", () => {
    it("reports mainnet-beta by default", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      expect(deps.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["mainnet-beta"]);
    });

    it("uses the configured cluster", () => {
      const wallet = makeWallet("Phantom");
      makeRegistry({ cluster: "devnet" });
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);
      expect(deps.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
    });

    it("falls back to the first cluster a wallet lists when it lacks mainnet", () => {
      const wallet = makeWallet("Devnet Only", { chains: ["solana:devnet", "solana:testnet"] });
      makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS, ["solana:devnet"])]);
      expect(deps.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
    });

    it("emits chain and re-tags the connection when the cluster changes while connected", () => {
      const wallet = makeWallet("Phantom");
      const registry = makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);

      registry.setCluster("devnet");

      expect(deps.chain.calledOnce).to.be.true;
      expect(deps.chain.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["devnet"],
        address: ADDRESS,
      });

      wallet.setAccounts([]);
      expect(deps.disconnect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["devnet"]);
    });

    it("records the new cluster centrally even when chain capture is off", () => {
      autocapture.chain = false;
      const wallet = makeWallet("Phantom");
      const registry = makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);

      registry.setCluster("devnet");

      expect(deps.chain.called).to.be.false;
      // The owner keeps its slot on the new cluster; no other namespace moves.
      expect(
        deps.restoreWalletState.calledWith({
          chainId: SOLANA_CHAIN_IDS["devnet"],
          address: ADDRESS,
        })
      ).to.be.true;
    });

    it("keeps the active wallet when a second wallet is also connected", () => {
      autocapture.chain = false;
      const phantom = makeWallet("Phantom");
      const solflare = makeWallet("Solflare");
      const registry = makeRegistry();
      installWalletAfterApp(phantom);
      installWalletAfterApp(solflare);
      phantom.setAccounts([account(ADDRESS)]);
      solflare.setAccounts([account(OTHER)]);
      // Solflare registered and connected last, but the SDK's active wallet
      // is Phantom. Registration order must not take the slot from it.
      currentAddress = ADDRESS;
      // Count only what the cluster switch writes, not the two connects.
      deps.syncWalletState.resetHistory();
      deps.restoreWalletState.resetHistory();

      registry.setCluster("devnet");

      expect(deps.syncWalletState.called).to.be.false;
      expect(deps.restoreWalletState.calledOnce).to.be.true;
      expect(deps.restoreWalletState.firstCall.args[0]).to.deep.equal({
        chainId: SOLANA_CHAIN_IDS["devnet"],
        address: ADDRESS,
      });
    });

    it("leaves central state to the store when the store owns wallet events", () => {
      ownsWalletEvents = false;
      const wallet = makeWallet("Phantom");
      const registry = makeRegistry();
      installWalletAfterApp(wallet);
      wallet.setAccounts([account(ADDRESS)]);

      registry.setCluster("devnet");

      expect(deps.syncWalletState.called).to.be.false;
    });

    it("emits no chain event when nothing is connected or the cluster is unchanged", () => {
      const wallet = makeWallet("Phantom");
      const registry = makeRegistry({ cluster: "devnet" });
      installWalletAfterApp(wallet);
      registry.setCluster("testnet");
      wallet.setAccounts([account(ADDRESS)]);
      registry.setCluster("testnet");
      expect(deps.chain.called).to.be.false;
      expect(deps.connect.firstCall.args[0].chainId).to.equal(SOLANA_CHAIN_IDS["testnet"]);
    });
  });

  // ── teardown ─────────────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("unsubscribes from wallets and stops answering registrations", () => {
      const wallet = makeWallet("Phantom");
      const registry = makeRegistry();
      installWalletAfterApp(wallet);
      expect(wallet.listenerCount()).to.equal(1);

      registry.cleanup();

      expect(wallet.listenerCount()).to.equal(0);
      wallet.setAccounts([account(ADDRESS)]);
      installWalletAfterApp(makeWallet("Solflare"));
      expect(deps.connect.called).to.be.false;
      expect(deps.detect.calledOnce).to.be.true;
      expect(registry.walletNames).to.deep.equal([]);
    });

    it("refuses a late register through the API a wallet kept", () => {
      let kept: WalletStandardRegisterApi | undefined;
      window.addEventListener("wallet-standard:app-ready", (event) => {
        kept = (event as unknown as { detail: WalletStandardRegisterApi }).detail;
      });
      const registry = makeRegistry();
      registry.cleanup();
      kept?.register(makeWallet("Phantom") as never);
      expect(deps.detect.called).to.be.false;
    });

    it("lets a second instance take over after the first is torn down", () => {
      const wallet = makeWallet("Phantom");
      installWalletBeforeApp(wallet);
      const first = makeRegistry();
      first.cleanup();
      const second = makeRegistry();
      expect(second.walletNames).to.deep.equal(["Phantom"]);
      expect(wallet.listenerCount()).to.equal(1);
    });
  });
});
