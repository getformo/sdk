import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: one wallet connection must produce exactly one connect event.
 *
 * `onConnected` and `onAccountsChanged` both observe the same connection, and
 * which of them saw the address first was decided purely by how many awaits
 * each happened to contain. Removing an analytics RPC from the
 * `accountsChanged` path was enough to flip that race and make both emit.
 */
describe("Duplicate connect on the EIP-1193 path", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  const ADDRESS = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const OTHER = "0x88C0224CEABF6D559d7B622F2918b308285280DE";

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });
    for (const [k, v] of [
      ["window", jsdom.window],
      ["globalThis", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
      ["Event", jsdom.window.Event],
      ["CustomEvent", jsdom.window.CustomEvent],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    for (const fn of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
      Object.defineProperty(global, fn, {
        value: (jsdom.window as any)[fn].bind(jsdom.window),
        writable: true, configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid" }, writable: true, configurable: true,
    });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    sandbox.restore();
    // Deliberately NOT deleting `globalThis` or the event methods: other
    // specs in this suite rely on them existing, and removing them here made
    // 16 unrelated tests fail.
    for (const k of ["window","document","location","navigator",
      "localStorage","sessionStorage","crypto"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  const makeProvider = (accounts: string[] = [ADDRESS]) => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const p: any = {
      chainId: "0x1",
      on: (ev: string, fn: any) => { (handlers[ev] ??= []).push(fn); },
      removeListener: () => undefined,
      request: async ({ method }: any) => {
        if (method === "eth_chainId") return "0x1";
        if (method?.startsWith("eth_accounts") || method === "eth_requestAccounts") return accounts;
        return null;
      },
      emit: (ev: string, ...a: unknown[]) => (handlers[ev] ?? []).forEach((f) => f(...a)),
    };
    return p;
  };

  async function connectAndCount(order: "connectFirst" | "accountsFirst") {
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    if (order === "connectFirst") {
      provider.emit("connect", { chainId: "0x1" });
      provider.emit("accountsChanged", [ADDRESS]);
    } else {
      provider.emit("accountsChanged", [ADDRESS]);
      provider.emit("connect", { chainId: "0x1" });
    }
    await new Promise((r) => setTimeout(r, 50));
    formo.cleanup?.();
    return connect.callCount;
  }

  it("emits exactly one connect when `connect` arrives first", async () => {
    expect(await connectAndCount("connectFirst")).to.equal(1);
  });

  it("emits exactly one connect when `accountsChanged` arrives first", async () => {
    expect(await connectAndCount("accountsFirst")).to.equal(1);
  });

  it("still reports the connect when an unknown-chain accounts event was refused", async () => {
    // `accountsChanged` arrives first on a provider with no synchronous
    // `chainId`, so it reports chain 0 - which `excludeChains` refuses. The
    // `connect` payload that follows carries the real chain and must still be
    // reported, or the connection produces no connect event at all.
    const provider = makeProvider();
    delete provider.chainId;                 // nothing to resolve from
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: { excludeChains: [999] },    // exclusions on => unknown fails closed
    });
    // Counts what is actually SENT, not what is attempted: the chain-0 attempt
    // is refused inside connect() by the exclusion gate, so stubbing
    // `formo.connect` would count an event that never reaches the wire.
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 40));
    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 60));

    const connects = sent.filter((e) => e.type === "connect");
    expect(connects.length, "exactly one connect is sent").to.equal(1);
    expect(
      connects[0].chainId,
      "and it carries the authoritative chain"
    ).to.equal(1);
    formo.cleanup?.();
  });

  it("reports the connect when the address was restored before `connect`", async () => {
    // A wallet restored from the active-wallet cookie means an address exists
    // with no connect ever sent. Suppressing on address presence lost it.
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    // Restored identity, exactly as loadActiveWallet() leaves it.
    (formo as any).setChainState("evm", { chainId: 1, address: ADDRESS });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerConnectListener(provider);

    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 60));

    expect(connect.callCount, "the connection is still reported").to.equal(1);
    formo.cleanup?.();
  });

  it("reports again after a genuine disconnect and reconnect", async () => {
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    sandbox.stub(formo, "disconnect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));
    expect(connect.callCount, "one for the first connection").to.equal(1);

    provider.emit("accountsChanged", []);
    await new Promise((r) => setTimeout(r, 60));

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));

    expect(connect.callCount, "and one for the reconnect").to.equal(2);
    formo.cleanup?.();
  });

  it("does not emit a second connect just to correct an unknown chain", async () => {
    // With no exclusions, an `accountsChanged` that wins the race on a
    // provider exposing no synchronous chainId reports chain 0 honestly. The
    // `connect` payload that follows knows the real chain, but relabelling by
    // emitting again would mean two connects for one connection.
    const provider = makeProvider();
    delete provider.chainId;
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 40));
    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 60));

    expect(connect.callCount, "exactly one connect").to.equal(1);
    expect(
      formo.currentChainId,
      "and the authoritative chain still lands in state"
    ).to.equal(1);
    formo.cleanup?.();
  });

  it("reports the connect once an excluded path stops suppressing it", async () => {
    // The connect is refused because the visitor is on an excluded path, not
    // because of anything about the wallet. Marking a refused event as
    // reported would silence that wallet for the rest of the page load, even
    // after navigation makes it trackable.
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: { excludePaths: ["/"] },
    });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));
    const whileExcluded = connect.callCount;

    // Navigate somewhere allowed; the same wallet is still connected.
    (global as any).window.history.pushState({}, "", "/allowed");
    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 60));

    expect(
      connect.callCount,
      "the wallet is reported once it becomes trackable"
    ).to.be.greaterThan(whileExcluded);
    formo.cleanup?.();
  });

  it("reports again when the user toggles back to an earlier wallet", async () => {
    // Two installed wallets. A's record must not outlive A being the active
    // provider, or coming back to A finds a stale record and every connect
    // after the first is silently lost.
    const a = makeProvider([ADDRESS]);
    const b = makeProvider([OTHER]);
    (global as any).window.ethereum = a;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    sandbox.stub(formo, "disconnect").resolves();
    for (const p of [a, b]) {
      (formo as any).registerAccountsChangedListener(p);
      (formo as any).registerConnectListener(p);
    }

    a.emit("connect", { chainId: "0x1" });
    a.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));
    expect(connect.callCount, "A reported").to.equal(1);

    // B takes over as the active wallet.
    b.emit("accountsChanged", [OTHER]);
    await new Promise((r) => setTimeout(r, 60));
    const afterB = connect.callCount;
    expect(afterB, "B reported").to.be.greaterThan(1);

    // Back to A.
    a.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));

    expect(
      connect.callCount,
      "returning to A is reported, not suppressed by a stale record"
    ).to.be.greaterThan(afterB);
    formo.cleanup?.();
  });

  it("still emits for an account switch after the wallet is known", async () => {
    // `accountsChanged` must keep reporting a NEW wallet, so the fix cannot
    // simply gate both handlers on the connection transition.
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 50));
    const afterConnect = connect.callCount;

    provider.emit("accountsChanged", [OTHER]);
    await new Promise((r) => setTimeout(r, 50));

    expect(afterConnect, "one for the connection").to.equal(1);
    expect(connect.callCount, "and one for the switch").to.equal(2);
    formo.cleanup?.();
  });
});
