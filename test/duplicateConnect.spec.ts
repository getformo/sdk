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
    // `accounts` is captured by reference so a test can empty it, which is how
    // a wallet stops holding the active slot.
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
    // `disconnect()` is deliberately NOT stubbed: it is what clears the active
    // provider on a real switch, and stubbing it hid the fact that the record
    // survived that path. Sends are counted at the queue instead.
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    const connect = { get callCount() { return sent.filter((e) => e.type === "connect").length; } };
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

  it("reports a reconnect even when disconnect autocapture is off", async () => {
    // The record is cleared by the `disconnect` listener, which used to be
    // registered only when disconnect autocapture was enabled - so with
    // `{ connect: true, disconnect: false }` a reconnect found the old record
    // still standing and was suppressed.
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      autocapture: { connect: true, disconnect: false },
    });
    const connect = sandbox.stub(formo, "connect").resolves();
    // Registered through the real tracking path, so the registration gate
    // itself is exercised. Wiring the listeners by hand would bypass the very
    // condition this test is about.
    (formo as any).isWagmiMode = false;
    (formo as any).trackEIP1193Provider(provider);
    await new Promise((r) => setTimeout(r, 40));

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));
    expect(connect.callCount, "first connection reported").to.equal(1);

    // The wallet drops via the provider's own `disconnect` event.
    provider.emit("disconnect");
    await new Promise((r) => setTimeout(r, 60));

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));

    expect(connect.callCount, "and so is the reconnect").to.equal(2);
    formo.cleanup?.();
  });

  it("drops a displaced provider's record on a chain-driven switch", async () => {
    // `handleProviderMismatch()` replaces the active provider through
    // `setChainState()`, which does not go via the `_provider` setter. A's
    // record has to be cleared there too, or coming back to A is suppressed.
    const a = makeProvider([ADDRESS]);
    const bAccounts = [OTHER];
    const b = makeProvider(bAccounts);
    (global as any).window.ethereum = a;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    for (const p of [a, b]) {
      (formo as any).registerAccountsChangedListener(p);
      (formo as any).registerConnectListener(p);
      (formo as any).registerChainChangedListener(p);
    }

    a.emit("connect", { chainId: "0x1" });
    a.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 60));
    expect(connect.callCount, "A reported").to.equal(1);

    // B takes the active slot via a chain event, not a disconnect. This goes
    // through handleProviderMismatch -> setChainState, which never touches the
    // `_provider` setter.
    b.emit("chainChanged", "0x89");
    await new Promise((r) => setTimeout(r, 60));
    expect((formo as any)._provider, "B displaced A").to.equal(b);

    // B then stops holding accounts, so A can take the slot back. Without
    // this the SDK correctly refuses to let a background wallet steal it.
    bAccounts.length = 0;

    a.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 80));
    expect(
      connect.callCount,
      "A's return is reported after being displaced"
    ).to.be.greaterThan(1);
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

  it("does not let a stale disconnect erase a reconnect that raced it", async () => {
    // Issue #344. `disconnect()` awaits event creation before it clears the
    // namespace. If the wallet reconnects during that await, the old code
    // cleared the NEW session's state and its reported-connect record, so the
    // next wallet signal emitted a second connect for a live connection.
    const accounts = [ADDRESS];
    const provider = makeProvider(accounts);
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });

    // Hold only the disconnect event open, so the reconnect lands squarely
    // inside `disconnect()`'s await.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => {
        if (e.type === "disconnect") await gate;
        sent.push(e);
      });

    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 40));
    expect(
      sent.filter((e) => e.type === "connect").length,
      "one connect for the first session"
    ).to.equal(1);

    // Wallet drops...
    accounts.length = 0;
    provider.emit("accountsChanged", []);
    await new Promise((r) => setTimeout(r, 20));

    // ...and comes straight back while the disconnect event is still building.
    accounts.push(ADDRESS);
    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 40));

    const beforeRelease = sent.filter((e) => e.type === "connect").length;
    release();
    await new Promise((r) => setTimeout(r, 40));

    // A later wallet signal must see the reconnect as already reported.
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 40));

    expect(
      sent.filter((e) => e.type === "connect").length,
      "the stale disconnect must not unreport the live session"
    ).to.equal(beforeRelease);
    expect(
      formo.currentAddress?.toLowerCase(),
      "and the live wallet must survive"
    ).to.equal(ADDRESS.toLowerCase());
    formo.cleanup?.();
  });

  it("does not let a stale Solana disconnect erase a reconnect that raced it", async () => {
    // Solana has no EIP-1193 provider, so a per-provider stamp could not see
    // this at all. The namespace generation can.
    const SOL_CHAIN = 900001;
    const SOL_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const SOL_B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => {
        if (e.type === "disconnect") await gate;
        sent.push(e);
      });

    await formo.connect({ chainId: SOL_CHAIN, address: SOL_A as any });
    expect(formo.currentAddress).to.equal(SOL_A);

    // Wallet A disconnects; the event stalls while B takes the namespace.
    const disconnecting = formo.disconnect({ chainId: SOL_CHAIN, address: SOL_A as any });
    await new Promise((r) => setTimeout(r, 10));
    await formo.connect({ chainId: SOL_CHAIN, address: SOL_B as any });

    release();
    await disconnecting;
    await new Promise((r) => setTimeout(r, 20));

    expect(
      formo.currentAddress,
      "the stale Solana disconnect must not clear the new session"
    ).to.equal(SOL_B);
    formo.cleanup?.();
  });

  it("does not let a stale disconnect erase a wallet adopted via syncWalletState", async () => {
    // An integration (the wagmi handler is one) adopts a wallet through the
    // public `syncWalletState()`, not through `connect()`. Bumping the
    // namespace generation only in `connect()` left that path invisible, so a
    // disconnect still in flight cleared the freshly adopted wallet.
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { if (e.type === "disconnect") await gate; });

    await formo.connect({ chainId: 1, address: ADDRESS });
    const disconnecting = formo.disconnect({ chainId: 1, address: ADDRESS });
    await new Promise((r) => setTimeout(r, 10));

    formo.syncWalletState({ chainId: 1, address: OTHER });
    expect(formo.currentAddress).to.equal(OTHER);

    release();
    await disconnecting;
    await new Promise((r) => setTimeout(r, 20));

    expect(
      formo.currentAddress,
      "a wallet adopted through syncWalletState must survive the stale cleanup"
    ).to.equal(OTHER);
    formo.cleanup?.();
  });

  it("abandons a wallet switch that a third provider overtook mid-disconnect", async () => {
    // A is active. B signals a switch and stalls awaiting A's disconnect
    // event. While it stalls, C changes network - which counts as a wallet
    // switch and makes C active - and then reports its own connect. A's
    // disconnect correctly leaves C alone, but B's continuation used to clear
    // C anyway and install itself, unreporting a live connection.
    const THIRD = "0x2F4bD6D2A5b7a19a49b6Cf2C0a0F1A5d33e8b7C1" as const;
    const providerA = makeProvider([ADDRESS]);
    const providerB = makeProvider([OTHER]);
    const providerC = makeProvider([THIRD]);
    (global as any).window.ethereum = providerA;
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      autocapture: { chain: true, connect: true, disconnect: true },
    } as any);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { if (e.type === "disconnect") await gate; });

    for (const p of [providerA, providerB, providerC]) {
      (formo as any).registerAccountsChangedListener(p);
      (formo as any).registerConnectListener(p);
      (formo as any).registerChainChangedListener(p);
    }

    providerA.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 40));
    expect(formo.currentAddress?.toLowerCase()).to.equal(ADDRESS.toLowerCase());

    // B signals a switch; its handler stalls on A's disconnect event.
    providerB.emit("accountsChanged", [OTHER]);
    await new Promise((r) => setTimeout(r, 20));

    // C overtakes: a chain change claims the active slot, then C connects.
    providerC.emit("chainChanged", "0x89");
    await new Promise((r) => setTimeout(r, 20));
    providerC.emit("connect", { chainId: "0x89" });
    await new Promise((r) => setTimeout(r, 40));
    expect(
      formo.currentAddress?.toLowerCase(),
      "C should own the slot before the stalled handler resumes"
    ).to.equal(THIRD.toLowerCase());

    release();
    await new Promise((r) => setTimeout(r, 60));

    expect(
      formo.currentAddress?.toLowerCase(),
      "the overtaken switch must not install itself over the newer session"
    ).to.equal(THIRD.toLowerCase());
    formo.cleanup?.();
  });

  it("does not let a stale connect observation cancel a newer disconnect", async () => {
    // The provider emits `connect` and then `accountsChanged([])`. The connect
    // handler is still resolving the address when the disconnect starts. If
    // that late continuation is allowed to claim the namespace, the disconnect
    // reads it as a reconnect and skips its cleanup, leaving a wallet that has
    // already gone away attached to every later event.
    const provider = makeProvider([ADDRESS]);
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });

    let releaseAddress!: () => void;
    const addressGate = new Promise<void>((r) => { releaseAddress = r; });
    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((r) => { releaseDisconnect = r; });

    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { if (e.type === "disconnect") await disconnectGate; });

    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    // Establish the session, then make the NEXT address read slow.
    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 40));
    expect(formo.currentAddress?.toLowerCase()).to.equal(ADDRESS.toLowerCase());

    const realGetAddress = (formo as any).getAddress.bind(formo);
    sandbox.stub(formo as any, "getAddress").callsFake(async (p: any) => {
      await addressGate;
      return realGetAddress(p);
    });

    // A second connect signal starts resolving its address...
    provider.emit("connect", { chainId: "0x1" });
    await new Promise((r) => setTimeout(r, 10));

    // ...and the wallet goes away while it is still resolving.
    provider.emit("accountsChanged", []);
    await new Promise((r) => setTimeout(r, 10));

    releaseAddress();
    await new Promise((r) => setTimeout(r, 30));
    releaseDisconnect();
    await new Promise((r) => setTimeout(r, 40));

    expect(
      formo.currentAddress,
      "the wallet disconnected, so no address may survive"
    ).to.equal(undefined);
    formo.cleanup?.();
  });
});
