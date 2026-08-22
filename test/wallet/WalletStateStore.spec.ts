import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { WalletStateStore } from "../../src/wallet/WalletStateStore";
import { initStorageManager, cookie } from "../../src/storage";
import { ACTIVE_WALLET_KEY } from "../../src/constants";
import { Address, EIP1193Provider } from "../../src/types";

/**
 * Wallet identity and chain state, exercised without an SDK instance.
 *
 * Before the split these rules could only be reached through
 * `FormoAnalytics`, which meant standing up a provider, a jsdom, storage and
 * an event queue to assert something as small as "a Solana disconnect must
 * not wipe EVM state".
 */
describe("WalletStateStore", () => {
  const EVM_A = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf" as Address;
  const EVM_B = "0x88C0224CEABF6D559d7B622F2918b308285280DE" as Address;
  const SOL_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
  const SOL_CHAIN = 900001;

  let jsdom: JSDOM;
  let suppressed: boolean;
  let purge: boolean;
  let pageExcluded: boolean;
  let providerChains: Map<EIP1193Provider, number>;
  let displaced: EIP1193Provider[];

  const store = () =>
    new WalletStateStore({
      isPersistedIdentityPurgeRequired: () => purge,
      isPageExcluded: () => pageExcluded,
      isTrackingSuppressed: () => suppressed,
      crossSubdomainCookies: () => false,
      providerChainId: (p) => providerChains.get(p),
      onProviderDisplaced: (p) => displaced.push(p),
    });

  const provider = (name: string) => ({ name }) as unknown as EIP1193Provider;

  beforeEach(() => {
    suppressed = false;
    purge = false;
    pageExcluded = false;
    providerChains = new Map();
    displaced = [];
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com/",
    });
    for (const k of ["window", "document", "location", "navigator"] as const) {
      Object.defineProperty(global, k, {
        value: k === "window" ? jsdom.window : (jsdom.window as any)[k],
        writable: true,
        configurable: true,
      });
    }
    initStorageManager("test-write-key");
    cookie().remove(ACTIVE_WALLET_KEY);
  });

  afterEach(() => {
    sinon.restore();
    for (const k of ["window", "document", "location", "navigator"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  describe("namespace isolation", () => {
    it("keeps EVM state when Solana disconnects, and the reverse", () => {
      const s = store();
      s.set(1, { address: EVM_A });
      s.set(SOL_CHAIN, { address: SOL_A });
      expect(s.address, "last connected wins").to.equal(SOL_A);

      s.clear(SOL_CHAIN);
      expect(s.address, "falls back to the wallet still connected").to.equal(EVM_A);
      expect(s.chainId).to.equal(1);

      s.set(SOL_CHAIN, { address: SOL_A });
      s.clear(1);
      expect(s.address).to.equal(SOL_A);
      expect(s.chainId).to.equal(SOL_CHAIN);
    });

    it("clears the derived values only when both namespaces are empty", () => {
      const s = store();
      s.set(1, { address: EVM_A });
      s.clear(1);
      expect(s.address).to.equal(undefined);
      expect(s.chainId).to.equal(undefined);
    });
  });

  describe("ordering", () => {
    it("supersedes an older observation with a newer one", () => {
      const s = store();
      const first = s.observe("evm");
      const second = s.observe("evm");
      expect(s.isCurrent(second)).to.be.true;
      expect(
        s.isCurrent(first),
        "an older handler must not write over a newer one"
      ).to.be.false;
    });

    it("orders each namespace separately", () => {
      const s = store();
      const evm = s.observe("evm");
      s.observe("solana");
      expect(s.isCurrent(evm), "Solana activity must not supersede EVM").to.be.true;
    });

    it("lets a snapshot ask the same question without taking a ticket", () => {
      // `disconnect()` is reached both directly and from a handler that
      // already holds a ticket. Taking a fresh one there would invalidate its
      // own caller.
      const s = store();
      const held = s.observe("evm");
      const snap = s.snapshot("evm");
      expect(s.isUnchangedSince("evm", snap)).to.be.true;
      expect(s.isCurrent(held), "the caller's ticket survives").to.be.true;
      s.observe("evm");
      expect(s.isUnchangedSince("evm", snap)).to.be.false;
    });

    it("counts disconnects separately from observations", () => {
      // A connect handler asks "did the wallet go away after I started?".
      // A newer CONNECT must not answer yes, or both handlers suppress and
      // the connect is lost entirely.
      const s = store();
      const before = s.disconnectsSoFar("evm");
      s.observe("evm");
      expect(
        s.disconnectsSoFar("evm"),
        "an ordinary observation is not a disconnect"
      ).to.equal(before);
      s.beginDisconnect("evm");
      expect(s.disconnectsSoFar("evm")).to.equal(before + 1);
    });

    it("counts disconnects per namespace", () => {
      const s = store();
      s.beginDisconnect("solana");
      expect(s.disconnectsSoFar("evm")).to.equal(0);
    });

    it("treats an integration's syncWalletState as a signal in the order", () => {
      const s = store();
      const held = s.observe("evm");
      s.syncWalletState({ chainId: 1, address: EVM_A });
      expect(
        s.isCurrent(held),
        "a wallet adopted by an integration supersedes an older handler"
      ).to.be.false;
    });
  });

  describe("provider displacement", () => {
    it("reports the provider that stopped being active", () => {
      const s = store();
      const a = provider("a");
      const b = provider("b");
      // Both writes matter: the transition from a to b is the behaviour under
      // test, so the first assignment is not dead despite being overwritten.
      s.provider = a;
      s.provider = b;
      expect(displaced).to.deep.equal([a]);
    });

    it("does not report a re-assignment of the same provider", () => {
      const s = store();
      const a = provider("a");
      // Assigning the same provider twice is the point: a no-op switch must
      // not end its connection.
      s.provider = a;
      s.provider = a;
      expect(displaced).to.deep.equal([]);
    });

    it("reports displacement when the namespace is wiped", () => {
      const s = store();
      const a = provider("a");
      s.provider = a;
      s.clear("evm");
      expect(displaced).to.deep.equal([a]);
    });
  });

  describe("backfill", () => {
    it("learns a wallet when nothing is known", () => {
      const s = store();
      s.backfill(EVM_A, 137);
      expect(s.address).to.equal(EVM_A);
      expect(s.chainId).to.equal(137);
    });

    it("never overwrites a different wallet", () => {
      const s = store();
      s.set(1, { address: EVM_A });
      s.backfill(EVM_B, 137);
      expect(s.address, "another wallet's business").to.equal(EVM_A);
      expect(s.chainId).to.equal(1);
    });

    it("corrects a stale chain for the wallet already known", () => {
      const s = store();
      s.set(1, { address: EVM_A });
      s.backfill(EVM_A, 137);
      expect(s.chainId).to.equal(137);
    });

    it("refuses a captured chain the provider has since left", () => {
      // A request captures its chain once and reuses it for every status it
      // emits. Writing that back on a later status restored a chain the
      // wallet had already moved off.
      const s = store();
      const p = provider("p");
      providerChains.set(p, 137);
      s.backfill(EVM_A, 1, p);
      expect(s.chainId).to.equal(137);
    });

    it("keeps 0, the unresolvable-chain marker", () => {
      // Erasing it to undefined removes the only signal that separates
      // "we asked and could not tell" from "no wallet yet", and the
      // exclusion gate needs that to fail closed.
      const s = store();
      s.backfill(EVM_A, 0);
      expect(s.chainId).to.equal(0);
    });

    it("learns nothing while tracking is suppressed", () => {
      suppressed = true;
      const s = store();
      s.backfill(EVM_A, 137);
      expect(s.address).to.equal(undefined);
    });
  });

  describe("syncWalletState", () => {
    it("records a valid wallet", () => {
      const s = store();
      s.syncWalletState({ chainId: 137, address: EVM_A });
      expect(s.address).to.equal(EVM_A);
    });

    it("rejects an address that is invalid for its chain", () => {
      const s = store();
      s.syncWalletState({ chainId: 1, address: "not-an-address" as Address });
      expect(s.address).to.equal(undefined);
    });

    it("clears both namespaces when no chain is named", () => {
      const s = store();
      s.set(1, { address: EVM_A });
      s.set(SOL_CHAIN, { address: SOL_A });
      s.syncWalletState({ address: undefined });
      expect(s.address).to.equal(undefined);
    });

    it("still clears a stale wallet while suppressed, but learns nothing", () => {
      // A switch observed on an excluded route must not leave the previous
      // address in memory, ready to attach to a later allowed-page event.
      const s = store();
      s.set(1, { address: EVM_A });
      suppressed = true;
      s.syncWalletState({ chainId: 1, address: EVM_B });
      expect(s.address, "the stale wallet is dropped").to.equal(undefined);
    });
  });

  describe("persistence", () => {
    it("round-trips the wallet through the cookie", () => {
      const a = store();
      a.set(137, { address: EVM_A });

      const b = store();
      b.load();
      expect(b.address).to.equal(EVM_A);
      expect(b.chainId).to.equal(137);
    });

    it("purges the cookie under visitor-level suppression", () => {
      const a = store();
      a.set(137, { address: EVM_A });
      purge = true;

      const b = store();
      b.load();
      expect(b.address).to.equal(undefined);
      expect(cookie().get(ACTIVE_WALLET_KEY)).to.satisfy(
        (v: unknown) => v === undefined || v === null || v === ""
      );
    });

    it("leaves an existing cookie untouched while on an excluded page", () => {
      // Host and path exclusions are transient. A cookie written on an
      // allowed page must survive a visit to an excluded route: neither
      // removed, nor overwritten with what happens there.
      const a = store();
      a.set(137, { address: EVM_A });
      const written = cookie().get(ACTIVE_WALLET_KEY) as string;
      expect(written).to.be.a("string");

      pageExcluded = true;
      a.set(1, { address: EVM_B });

      expect(
        cookie().get(ACTIVE_WALLET_KEY),
        "the allowed-page snapshot survives unchanged"
      ).to.equal(written);
    });

    it("does not restore into memory while on an excluded page", () => {
      const a = store();
      a.set(137, { address: EVM_A });
      pageExcluded = true;

      const b = store();
      b.load();
      expect(b.address).to.equal(undefined);
    });

    it("drops a snapshot whose address is invalid for its chain", () => {
      cookie().set(ACTIVE_WALLET_KEY, JSON.stringify({ address: "0xnope", chainId: 1 }));
      const s = store();
      s.load();
      expect(s.address).to.equal(undefined);
    });

    it("survives a corrupt snapshot", () => {
      cookie().set(ACTIVE_WALLET_KEY, "not-json{");
      const s = store();
      s.load();
      expect(s.address).to.equal(undefined);
    });

    it("restores a Solana wallet into the Solana namespace", () => {
      const a = store();
      a.set(SOL_CHAIN, { address: SOL_A });
      const b = store();
      b.load();
      expect(b.address).to.equal(SOL_A);
      expect(b.chainId).to.equal(SOL_CHAIN);
    });
  });

  describe("reset", () => {
    it("clears identity but keeps the provider so tracking can resume", () => {
      const s = store();
      const p = provider("p");
      s.provider = p;
      s.set(1, { address: EVM_A });
      s.reset();
      expect(s.address).to.equal(undefined);
      expect(s.provider, "the provider survives a reset").to.equal(p);
    });
  });

  describe("review follow-ups", () => {
    it("orders a Solana wallet swap even when only the case differs", () => {
      // Base58 is case-sensitive, so these are different wallets. The old
      // guard compared addresses to decide whether a session had changed
      // hands, and lowercased every namespace, folding them into one. The
      // ordering model does not compare addresses at all: any wallet signal
      // supersedes an older handler, whatever the addresses look like.
      const s = store();
      const held = s.observe("solana");
      s.syncWalletState({ chainId: SOL_CHAIN, address: SOL_A });
      expect(s.isCurrent(held)).to.be.false;
    });

    it("rejects a snapshot whose chain is present but unusable", () => {
      // The cookie is attacker-writable and survives across SDK versions. A
      // string "137" restored as-is never matches a numeric exclusion list,
      // so an excluded chain would silently start reporting again.
      cookie().set(
        ACTIVE_WALLET_KEY,
        JSON.stringify({ address: EVM_A, chainId: "137" })
      );
      const s = store();
      s.load();
      expect(s.address, "the whole snapshot is refused").to.equal(undefined);
      expect(s.chainId).to.equal(undefined);
    });

    it("does not file a Solana wallet under EVM when its chain is corrupt", () => {
      // Downgrading an unusable chain to "chainless" looks harmless and is
      // not: the namespace is derived from the chain, so the wallet lands in
      // the wrong one and a later Solana disconnect falls through to a
      // phantom EVM entry.
      cookie().set(
        ACTIVE_WALLET_KEY,
        JSON.stringify({ address: SOL_A, chainId: "900001" })
      );
      const s = store();
      s.load();
      expect(s.evmAddress, "no phantom EVM wallet").to.equal(undefined);
      expect(s.address).to.equal(undefined);
    });

    it("still restores a snapshot that legitimately has no chain", () => {
      cookie().set(ACTIVE_WALLET_KEY, JSON.stringify({ address: EVM_A }));
      const s = store();
      s.load();
      expect(s.address).to.equal(EVM_A);
      expect(s.chainId).to.equal(undefined);
    });

    it("lets a wallet that actually connects outrank one named by identify", () => {
      // `setActiveAddress()` is deliberately transient. Making an identify
      // sticky until the next identify would mis-attribute every event after
      // a connect. Pinning the order so it cannot drift unnoticed.
      const s = store();
      s.setActiveAddress(EVM_A);
      expect(s.address).to.equal(EVM_A);
      s.set(1, { address: EVM_B });
      expect(s.address, "the connected wallet wins").to.equal(EVM_B);
    });
  });

});
