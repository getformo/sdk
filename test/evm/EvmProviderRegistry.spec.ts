import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { EvmProviderRegistry } from "../../src/evm/EvmProviderRegistry";
import { Address, ChainID, EIP1193Provider } from "../../src/types";

/**
 * The EVM provider registry, exercised without an SDK instance.
 *
 * "Which wallets exist and what do we know about each" used to be spread
 * across three sets, two WeakMaps and a listener map on a 3400-line class,
 * reachable only by constructing the whole SDK.
 */
describe("EvmProviderRegistry", () => {
  let jsdom: JSDOM;
  let active: EIP1193Provider | undefined;
  let activeChain: ChainID | undefined;
  let knownAddress: Address | undefined;
  let observed: Array<[EIP1193Provider, number]>;

  const registry = () =>
    new EvmProviderRegistry({
      activeProvider: () => active,
      activeChainId: () => activeChain,
      knownEvmAddress: () => knownAddress,
      onChainObserved: (p, c) => observed.push([p, c]),
    });

  const makeProvider = (accounts: string[] = []) => {
    const removed: Array<[string, unknown]> = [];
    const p = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return accounts;
        return null;
      },
      removeListener: (ev: string, fn: unknown) => removed.push([ev, fn]),
      removed,
    };
    return p as unknown as EIP1193Provider & { removed: Array<[string, unknown]> };
  };

  const detail = (provider: EIP1193Provider, name: string, rdns: string) =>
    ({ provider, info: { name, rdns, icon: "", uuid: name } }) as any;

  beforeEach(() => {
    active = undefined;
    activeChain = undefined;
    knownAddress = undefined;
    observed = [];
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com/",
    });
    for (const k of ["window", "document", "navigator"] as const) {
      Object.defineProperty(global, k, {
        value: k === "window" ? jsdom.window : (jsdom.window as any)[k],
        writable: true,
        configurable: true,
      });
    }
  });

  afterEach(() => {
    for (const k of ["window", "document", "navigator"]) delete (global as any)[k];
    jsdom?.window.close();
  });

  describe("supplied attribution", () => {
    // The wagmi fallback wrap records the CONNECTOR for a provider that was
    // never announced, so request-derived events name the same wallet as
    // the hook-driven ones from that connection.
    it("names an unannounced provider after the supplied attribution", () => {
      const r = registry();
      const p = makeProvider();
      r.rememberAttribution(p, { name: "Rabby", rdns: "io.rabby" });
      expect(r.infoFor(p)).to.deep.equal({ name: "Rabby", rdns: "io.rabby" });
    });

    it("keeps the sniffed rdns when the attribution has none", () => {
      const r = registry();
      const p = makeProvider();
      r.rememberAttribution(p, { name: "Rabby" });
      expect(r.infoFor(p)).to.deep.equal({ name: "Rabby", rdns: "io.injected.provider" });
    });

    it("lets a live WalletConnect peer rename a supplied attribution", () => {
      // The hook path names the peer over the connector; the request path
      // must agree, and must follow a session that changes wallets.
      const r = registry();
      const p = makeProvider() as any;
      r.rememberAttribution(p, { name: "WalletConnect" });
      p.session = { peer: { metadata: { name: "Ledger Live", url: "https://ledger.com" } } };
      expect(r.infoFor(p)).to.deep.equal({ name: "Ledger Live", rdns: "com.walletconnect" });
      p.session = { peer: { metadata: { name: "Rainbow", url: "https://rainbow.me" } } };
      expect(r.infoFor(p).name).to.equal("Rainbow");
    });

    it("forgets the attribution when told to", () => {
      const r = registry();
      const p = makeProvider();
      r.rememberAttribution(p, { name: "Rabby" });
      r.rememberAttribution(p, undefined);
      expect(r.infoFor(p).name).to.equal("Injected Provider");
    });

    it("never overrides EIP-6963 announcement metadata", () => {
      const r = registry();
      const p = makeProvider();
      r.add(detail(p, "Rainbow", "me.rainbow"));
      r.rememberAttribution(p, { name: "Something Else" });
      expect(r.infoFor(p)).to.deep.equal({ name: "Rainbow", rdns: "me.rainbow" });
    });
  });

  describe("the provider set", () => {
    it("adds a provider once", () => {
      const r = registry();
      const p = makeProvider();
      expect(r.add(detail(p, "Rainbow", "me.rainbow"))).to.be.true;
      expect(r.add(detail(p, "Rainbow", "me.rainbow")), "second add is a no-op")
        .to.be.false;
      expect(r.all).to.have.length(1);
      expect(r.isSeen(p)).to.be.true;
    });

    it("keeps discovery and tracking separate", () => {
      // A provider can be discovered without having listeners wired up.
      const r = registry();
      const p = makeProvider();
      r.add(detail(p, "Rainbow", "me.rainbow"));
      expect(r.isTracked(p), "discovered is not tracked").to.be.false;
      r.markTracked(p);
      expect(r.isTracked(p)).to.be.true;
      r.forgetTracked(p);
      expect(r.isTracked(p)).to.be.false;
      expect(r.all, "untracking does not undiscover").to.have.length(1);
    });

    it("prefers announced metadata over sniffing the injected provider", () => {
      const r = registry();
      const p = makeProvider();
      r.add(detail(p, "Rainbow", "me.rainbow"));
      expect(r.infoFor(p)).to.deep.equal({ name: "Rainbow", rdns: "me.rainbow" });
    });

    it("falls back to injected detection for a provider that never announced", () => {
      const r = registry();
      const info = r.infoFor(makeProvider());
      expect(info).to.have.keys(["name", "rdns"]);
      expect(info.name).to.be.a("string");
    });
  });

  describe("listener bookkeeping", () => {
    it("removes only the listeners it attached", () => {
      const r = registry();
      const p = makeProvider();
      const mine = () => undefined;
      r.addListener(p, "accountsChanged", mine);
      r.removeListeners(p);
      expect((p as any).removed).to.deep.equal([["accountsChanged", mine]]);
    });

    it("is a no-op for a provider it never touched", () => {
      const r = registry();
      const p = makeProvider();
      r.removeListeners(p);
      expect((p as any).removed).to.deep.equal([]);
    });

    it("keeps a listener it could not remove, so teardown can retry", () => {
      // Forgetting a listener that is still attached loses the only reference
      // to it: nothing can try again, and the callback holds the instance it
      // closes over for the life of the page.
      const r = registry();
      let failing = true;
      const removed: string[] = [];
      const p = {
        removeListener: (ev: string) => {
          if (ev === "accountsChanged" && failing) throw new Error("busy");
          removed.push(ev);
        },
      } as unknown as EIP1193Provider;

      r.addListener(p, "accountsChanged", () => undefined);
      r.addListener(p, "chainChanged", () => undefined);
      r.removeListeners(p);
      expect(removed).to.deep.equal(["chainChanged"]);
      expect(
        r.attachedEvents(p),
        "the one that failed is retained"
      ).to.deep.equal(["accountsChanged"]);

      failing = false;
      r.removeListeners(p);
      expect(removed).to.deep.equal(["chainChanged", "accountsChanged"]);
      expect(r.attachedEvents(p), "nothing left after a clean retry").to.deep.equal([]);
    });

    it("does not let a throwing removeListener abort the rest", () => {
      const r = registry();
      const removed: string[] = [];
      const p = {
        removeListener: (ev: string) => {
          if (ev === "a") throw new Error("boom");
          removed.push(ev);
        },
      } as unknown as EIP1193Provider;
      r.addListener(p, "a", () => undefined);
      r.addListener(p, "b", () => undefined);
      r.removeListeners(p);
      expect(removed, "the second listener is still removed").to.deep.equal(["b"]);
    });
  });

  describe("per-provider chain knowledge", () => {
    it("records a chain and reports the observation", () => {
      const r = registry();
      const p = makeProvider();
      r.rememberChain(p, 137);
      expect(r.chainIdOf(p)).to.equal(137);
      expect(observed).to.deep.equal([[p, 137]]);
    });

    it("ignores an absent provider or chain", () => {
      const r = registry();
      r.rememberChain(undefined, 137);
      r.rememberChain(makeProvider(), undefined);
      expect(observed).to.deep.equal([]);
    });

    it("advances the observation generation on every record", () => {
      const r = registry();
      const p = makeProvider();
      const before = r.chainGeneration(p);
      r.rememberChain(p, 1);
      r.rememberChain(p, 137);
      expect(r.chainGeneration(p)).to.equal(before + 2);
    });

    it("answers from the provider's own snapshot", () => {
      const r = registry();
      const p = makeProvider();
      r.rememberChain(p, 137);
      expect(r.resolveChainId(p)).to.equal(137);
    });

    it("reports 0 for a wallet it has never heard a chain from", () => {
      // Deliberately not the active provider's chain: that belongs to a
      // different wallet, and guessing mis-attributes the event.
      const r = registry();
      const other = makeProvider();
      active = makeProvider();
      activeChain = 137;
      expect(r.resolveChainId(other)).to.equal(0);
    });

    it("uses central state only for the active provider", () => {
      const r = registry();
      const p = makeProvider();
      active = p;
      activeChain = 137;
      expect(r.resolveChainId(p)).to.equal(137);
    });

    it("falls back to central state when no provider is named", () => {
      const r = registry();
      activeChain = 42;
      expect(r.resolveChainId()).to.equal(42);
      activeChain = undefined;
      expect(r.resolveChainId()).to.equal(0);
    });
  });

  describe("reading accounts", () => {
    it("returns checksummed accounts", async () => {
      const r = registry();
      const p = makeProvider(["0x51377e9b985bb90b7c091b9a7d30c93d4c9c1cef"]);
      const accounts = await r.accountsOf(p);
      expect(accounts).to.deep.equal(["0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf"]);
    });

    it("drops accounts that are not valid addresses", async () => {
      const r = registry();
      const p = makeProvider(["not-an-address"]);
      expect(await r.accountsOf(p)).to.deep.equal([]);
    });

    it("returns null when the wallet reports nothing", async () => {
      const r = registry();
      expect(await r.accountsOf(makeProvider([]))).to.equal(null);
    });

    it("returns null when the request throws", async () => {
      const r = registry();
      const p = {
        request: async () => { throw Object.assign(new Error("no"), { code: 4001 }); },
      } as unknown as EIP1193Provider;
      expect(await r.accountsOf(p)).to.equal(null);
    });

    it("prefers what the SDK already knows for the active provider", async () => {
      // An EVM context must never return a Solana address, and there is no
      // reason to ask a wallet something already in hand.
      const r = registry();
      knownAddress = "0x88C0224CEABF6D559d7B622F2918b308285280DE" as Address;
      let asked = false;
      const p = {
        request: async () => { asked = true; return []; },
      } as unknown as EIP1193Provider;
      active = p;
      expect(await r.addressOf(p)).to.equal(knownAddress);
      expect(asked, "no RPC was issued").to.be.false;
    });

    it("prefers what the SDK already knows when no provider is named", async () => {
      const r = registry();
      knownAddress = "0x88C0224CEABF6D559d7B622F2918b308285280DE" as Address;
      active = makeProvider([]);
      expect(await r.addressOf()).to.equal(knownAddress);
    });

    it("does not report the active wallet's address for another provider", async () => {
      // `identify()` scans every discovered provider. Answering from the
      // cache each time identified one wallet under every other wallet's
      // name and rdns.
      const r = registry();
      knownAddress = "0x88C0224CEABF6D559d7B622F2918b308285280DE" as Address;
      active = makeProvider([]);
      const other = makeProvider(["0x51377e9b985bb90b7c091b9a7d30c93d4c9c1cef"]);
      expect(await r.addressOf(other)).to.equal(
        "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf"
      );
    });

    it("reports nothing for a provider with no accounts, even when a wallet is known", () => {
      const r = registry();
      knownAddress = "0x88C0224CEABF6D559d7B622F2918b308285280DE" as Address;
      active = makeProvider([]);
      return r.addressOf(makeProvider([])).then((a) => expect(a).to.equal(null));
    });

    it("falls back to the active provider when none is named", async () => {
      const r = registry();
      active = makeProvider(["0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf"]);
      expect(await r.addressOf()).to.equal(
        "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf"
      );
    });

    it("returns null with no provider at all", async () => {
      expect(await registry().addressOf()).to.equal(null);
    });
  });

  describe("teardown eligibility", () => {
    it("still counts a provider as tracked when its listeners would not detach", () => {
      // `cleanup()` iterates the TRACKED set. A provider dropped from it
      // while a listener is still attached becomes unreachable, so the
      // retention that makes a retry possible never gets used.
      const r = registry();
      const p = {
        removeListener: () => { throw new Error("busy"); },
      } as unknown as EIP1193Provider;
      r.markTracked(p);
      r.addListener(p, "accountsChanged", () => undefined);

      r.removeListeners(p);
      expect(r.attachedEvents(p)).to.deep.equal(["accountsChanged"]);
      expect(
        r.isTracked(p),
        "a provider we could not detach from is still one we are attached to"
      ).to.be.true;
    });

    it("reports nothing attached once teardown succeeds", () => {
      const r = registry();
      const p = makeProvider();
      r.markTracked(p);
      r.addListener(p, "accountsChanged", () => undefined);
      r.removeListeners(p);
      expect(r.attachedEvents(p)).to.deep.equal([]);
    });
  });
});
