import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";
import { WRAPPED_REQUEST_OWNER_SYMBOL } from "../../src/types";

/**
 * registerProvider (P-2403).
 *
 * Discovery only sees EIP-6963 announcements and `window.ethereum`, which is
 * every injected wallet and nothing else. WalletConnect and Ledger providers
 * are constructed by the app and announce nothing, so their sessions were
 * invisible: production showed ONE WalletConnect detect event in 30 days
 * against 81k for MetaMask. `registerProvider` is the missing entry point:
 * the same pipeline a discovered provider takes, for a provider the page
 * hands over itself.
 */
describe("registerProvider", () => {
  const ADDR = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const OTHER = "0x88C0224CEABF6D559d7B622F2918b308285280DE";
  const PEER = "Ledger Live";

  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  // Original global descriptors, restored verbatim in afterEach. Deleting
  // is wrong for keys Node itself defines (Event, addEventListener, ...):
  // it would remove the built-in for every later spec in the process.
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  const GLOBAL_KEYS = [
    "window","document","location","navigator","localStorage","sessionStorage",
    "Event","CustomEvent","addEventListener","removeEventListener","dispatchEvent","crypto",
  ] as const;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    savedGlobals = new Map(
      GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(global, k)])
    );
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
    savedGlobals.forEach((desc, k) => {
      if (desc) Object.defineProperty(global, k, desc);
      else delete (global as any)[k];
    });
    jsdom?.window.close();
  });

  /**
   * A WalletConnect-shaped provider: constructed, never announced, never at
   * window.ethereum. Synchronous `accounts`/`chainId` state and a session
   * with peer metadata, exactly as @walletconnect/ethereum-provider exposes.
   */
  const makeWcProvider = (opts: { accounts?: string[]; peer?: string } = {}) => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const p: any = {
      accounts: opts.accounts ?? [],
      chainId: "0x1",
      session:
        opts.peer !== undefined
          ? { peer: { metadata: { name: opts.peer, url: "https://ledger.com" } } }
          : undefined,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_accounts") return p.accounts;
        if (method === "personal_sign") return "0xsigned";
        return null;
      },
      on: (ev: string, fn: any) => { (handlers[ev] ??= []).push(fn); },
      removeListener: (ev: string, fn: any) => {
        handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn);
      },
      emit: (ev: string, ...a: unknown[]) => (handlers[ev] ?? []).forEach((f) => f(...a)),
    };
    return p;
  };

  async function setup(options: any = { tracking: true }) {
    const formo = await FormoAnalytics.init("test-write-key", options);
    const sent: any[] = [];
    sandbox.stub((formo as any).eventManager, "addEvent")
      .callsFake(async (e: any) => { sent.push(e); });
    return { formo, sent };
  }

  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it("captures nothing from a constructed provider that is never registered", async () => {
    // Today's failure, pinned: this is the P-2403 gap itself.
    const provider = makeWcProvider({ accounts: [ADDR] });
    const { formo, sent } = await setup();

    provider.emit("accountsChanged", [ADDR]);
    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(sent.filter((e) => e.type !== "page")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("tracks a registered provider end to end: detect, connect, signature", async () => {
    const provider = makeWcProvider({ peer: PEER });
    const { formo, sent } = await setup();

    expect(formo.registerProvider(provider)).to.equal(true);
    provider.accounts = [ADDR];
    provider.emit("accountsChanged", [ADDR]);
    await provider.request({ method: "personal_sign", params: ["0x68656c6c6f", ADDR] });
    await settle();

    const types = sent.map((e) => e.type);
    expect(types).to.include("detect");
    expect(types).to.include("connect");
    expect(sent.filter((e) => e.type === "signature").length, "requested + confirmed").to.equal(2);
    formo.cleanup?.();
  });

  it("adopts a session that already exists at registration, with no RPC", async () => {
    // WalletConnect apps typically connect BEFORE any analytics call runs.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const requestSpy = sandbox.spy(provider, "request");
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    expect(sent.some((e) => e.type === "connect" && e.address === ADDR)).to.equal(true);
    // Nothing analytics-only may go on the wallet transport, least of all
    // WalletConnect's serialised relay socket.
    expect(requestSpy.called).to.equal(false);
    formo.cleanup?.();
  });

  it("names the real wallet behind the transport from peer metadata", async () => {
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    // At the addEvent stage detect carries its identity at the top level;
    // the wire serializer nests and snake_cases it later.
    const detect = sent.find((e) => e.type === "detect");
    expect(detect?.providerName).to.equal(PEER);
    expect(detect?.rdns).to.equal("com.walletconnect");
    formo.cleanup?.();
  });

  it("lets caller info override everything", async () => {
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();

    formo.registerProvider(provider, { name: "My Kiosk Wallet", rdns: "com.example.kiosk" });
    await settle();

    const detect = sent.find((e) => e.type === "detect");
    expect(detect?.providerName).to.equal("My Kiosk Wallet");
    expect(detect?.rdns).to.equal("com.example.kiosk");
    formo.cleanup?.();
  });

  it("falls back to flag sniffing when there is no session peer", async () => {
    const provider = makeWcProvider({ accounts: [ADDR] });
    provider.isWalletConnect = true;
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    const detect = sent.find((e) => e.type === "detect");
    expect(detect?.providerName).to.equal("WalletConnect");
    formo.cleanup?.();
  });

  it("is idempotent: registering twice tracks once", async () => {
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    formo.registerProvider(provider);
    await settle();

    expect(sent.filter((e) => e.type === "connect").length).to.equal(1);
    formo.cleanup?.();
  });

  it("names the signer on connects even when the session forms after registration", async () => {
    // The recommended order is register-early-then-connect, so the peer
    // is unknown at registration - and this provider carries NO
    // isWalletConnect flag, so at registration it detects as nothing at
    // all. The name resolves LIVE per event: once the session exists, its
    // peer is the proof of what the provider was, and the connect carries
    // the signer with the WalletConnect rdns.
    const provider = makeWcProvider({});
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    // Session forms now, after registration.
    provider.session = { peer: { metadata: { name: PEER, url: "https://ledger.com" } } };
    provider.accounts = [ADDR];
    provider.emit("accountsChanged", [ADDR]);
    await settle();

    const connect = sent.find((e) => e.type === "connect");
    expect(connect?.properties?.providerName).to.equal(PEER);
    expect(connect?.properties?.rdns).to.equal("com.walletconnect");
    formo.cleanup?.();
  });

  it("keeps capturing after an SDK rebuild over the same provider", async () => {
    // The wrapper survives a rebuild and used to keep feeding the OLD
    // instance's closed queue while the new registration reported success.
    // Ownership now rebinds: the new instance's queue gets the events.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const first = await setup();
    expect(first.formo.registerProvider(provider)).to.equal(true);
    await settle();
    first.formo.cleanup?.();

    const second = await setup();
    expect(second.formo.registerProvider(provider)).to.equal(true);
    await settle();
    second.sent.length = 0;

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      second.sent.filter((e) => e.type === "signature").length,
      "the LIVE instance captures requested + confirmed"
    ).to.equal(2);
    second.formo.cleanup?.();
  });

  it("renames when a later session belongs to a different wallet", async () => {
    // Peer names resolve live per read, never frozen at registration.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();
    formo.registerProvider(provider);
    await settle();
    expect(sent.find((e) => e.type === "connect")?.properties?.providerName).to.equal(PEER);

    sent.length = 0;
    provider.session = { peer: { metadata: { name: "MetaMask Mobile" } } };
    provider.emit("accountsChanged", []);
    await settle();
    provider.emit("accountsChanged", [ADDR]);
    await settle();

    const reconnect = sent.find((e) => e.type === "connect");
    expect(reconnect?.properties?.providerName).to.equal("MetaMask Mobile");
    formo.cleanup?.();
  });

  it("routes to the newest LIVE instance when several registered", async () => {
    // Owner routing is newest-live-wins: a cleaned-up newest instance must
    // hand capture back to the older live one, not swallow events into its
    // closed queue.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const a = await setup();
    expect(a.formo.registerProvider(provider)).to.equal(true);
    const b = await setup();
    expect(b.formo.registerProvider(provider)).to.equal(true);
    await settle();
    b.formo.cleanup?.();
    a.sent.length = 0;

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      a.sent.filter((e) => e.type === "signature").length,
      "instance A captures after B is torn down"
    ).to.equal(2);
    a.formo.cleanup?.();
  });

  it("prunes a torn-down instance from the provider's owner list", async () => {
    // The list lives on the LONG-LIVED provider; a disposed instance left
    // in it retains its whole object graph across every rebuild.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const a = await setup();
    a.formo.registerProvider(provider);
    const b = await setup();
    b.formo.registerProvider(provider);
    await settle();

    const owners = () =>
      ((provider as any)[WRAPPED_REQUEST_OWNER_SYMBOL] as unknown[]) ?? [];
    expect(owners().length).to.equal(2);

    a.formo.cleanup?.();
    expect(owners().length, "A pruned itself on cleanup").to.equal(1);
    b.formo.cleanup?.();
    expect(owners().length, "nothing retained after both").to.equal(0);
  });

  it("keeps every registrant when a wallet's request replacement forces a re-wrap", async () => {
    // A wallet replacing provider.request defeats the marker and forces a
    // fresh wrap. That install must MERGE ownership, not restart it: after
    // the re-wrapping instance is torn down, the other live registrant
    // still captures.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    // A wallet that replaces `request` restores its OWN transport - the
    // wrapper is gone from the chain, not layered under the replacement.
    const native = provider.request.bind(provider);
    const b = await setup();
    b.formo.registerProvider(provider);
    const a = await setup();
    a.formo.registerProvider(provider);
    await settle();

    provider.request = (args: unknown) => (native as any)(args);
    // Re-registration through the PUBLIC path must re-verify the wrapper.
    expect(a.formo.registerProvider(provider)).to.equal(true);
    await settle();

    a.formo.cleanup?.();
    b.sent.length = 0;
    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      b.sent.filter((e) => e.type === "signature").length,
      "B still captures after the re-wrapper is gone"
    ).to.equal(2);
    b.formo.cleanup?.();
  });

  it("adopts a session whose accounts live only in the namespaces", async () => {
    // Observed live with MetaMask Mobile: provider.accounts EMPTY while the
    // session namespaces held "eip155:11155111:0x...". The namespaces are
    // the session's ground truth and adoption must read them.
    const provider = makeWcProvider({ peer: PEER });
    provider.accounts = [];
    provider.session = {
      peer: { metadata: { name: PEER } },
      namespaces: { eip155: { accounts: [`eip155:11155111:${ADDR}`, `eip155:1:${ADDR}`] } },
    };
    const { formo, sent } = await setup();

    formo.registerProvider(provider);
    await settle();

    const connect = sent.find((e) => e.type === "connect");
    expect(connect?.address?.toLowerCase()).to.equal(ADDR.toLowerCase());
    formo.cleanup?.();
  });

  it("reports a WalletConnect-style rejection (code 5000) as rejected", async () => {
    // Live finding: WalletConnect wallets reject with sdkError USER_REJECTED
    // {code: 5000}, not EIP-1193's 4001 - and a 4001-only match reported
    // NOTHING for every WalletConnect rejection.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    provider.request = async ({ method }: { method: string }) => {
      if (method === "personal_sign") {
        const e = new Error("User rejected.");
        (e as any).code = 5000;
        throw e;
      }
      if (method === "eth_accounts") return provider.accounts;
      return null;
    };
    const { formo, sent } = await setup();
    formo.registerProvider(provider);
    await settle();

    await provider
      .request({ method: "personal_sign", params: ["0x68", ADDR] })
      .catch(() => undefined);
    await settle();

    const statuses = sent.filter((e) => e.type === "signature").map((e) => e.status);
    expect(statuses).to.deep.equal(["requested", "rejected"]);
    formo.cleanup?.();
  });

  it("prefers the active chain's account when the session differs per chain", async () => {
    // WalletConnect permits different accounts per chain; the adopted
    // address must be the one the ACTIVE chain authorized.
    const provider = makeWcProvider({ peer: PEER });
    provider.accounts = [];
    provider.chainId = "0x1";
    provider.session = {
      peer: { metadata: { name: PEER } },
      namespaces: { eip155: { accounts: [`eip155:11155111:${OTHER}`, `eip155:1:${ADDR}`] } },
    };
    const { formo, sent } = await setup();
    formo.registerProvider(provider);
    await settle();

    const connect = sent.find((e) => e.type === "connect");
    expect(connect?.address?.toLowerCase()).to.equal(ADDR.toLowerCase());
    formo.cleanup?.();
  });

  it("ignores non-EVM namespaces when adopting from the session", async () => {
    // A session can carry Solana alongside eip155; a non-EVM address fed
    // into EVM adoption would fail validation and drop the whole adoption.
    const provider = makeWcProvider({ peer: PEER });
    provider.accounts = [];
    provider.session = {
      peer: { metadata: { name: PEER } },
      namespaces: {
        solana: { accounts: ["solana:mainnet:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] },
        eip155: { accounts: [`eip155:11155111:${ADDR}`] },
      },
    };
    const { formo, sent } = await setup();
    formo.registerProvider(provider);
    await settle();

    const connect = sent.find((e) => e.type === "connect");
    expect(connect?.address?.toLowerCase()).to.equal(ADDR.toLowerCase());
    formo.cleanup?.();
  });

  it("refuses registration on a cleaned-up instance", async () => {
    const { formo } = await setup();
    formo.cleanup?.();
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(false);
  });

  it("retries a suppressed adoption when the visitor opts back in", async () => {
    const { formo, sent } = await setup();
    formo.optOutTracking();
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    formo.registerProvider(provider);
    await settle();
    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);

    formo.optInTracking();
    await settle(60);

    expect(
      sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === ADDR.toLowerCase()),
      "adoption retried after opt-in"
    ).to.equal(true);
    formo.cleanup?.();
  });

  it("keeps a suppressed adoption pending across page hits until suppression ends", async () => {
    // A page hit while still opted out must neither adopt (it would be
    // refused again) nor forget the provider (nothing else would retry).
    const { formo, sent } = await setup();
    formo.optOutTracking();
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    formo.registerProvider(provider);
    await settle();

    await formo.page();
    await settle(60);
    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);

    formo.optInTracking();
    await settle(60);
    expect(
      sent.filter((e) => e.type === "connect" && e.address?.toLowerCase() === ADDR.toLowerCase()).length,
      "adopted exactly once, after opt-in"
    ).to.equal(1);
    formo.cleanup?.();
  });

  it("retries an adoption refused on an excluded path once the visitor navigates away", async () => {
    const { formo, sent } = await setup({ tracking: { excludePaths: ["/"] } });
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(true);
    await settle();
    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);

    (global as any).window.history.pushState({}, "", "/app");
    await formo.page();
    await settle(60);

    expect(
      sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === ADDR.toLowerCase()),
      "adoption retried on the first trackable page hit"
    ).to.equal(true);
    formo.cleanup?.();
  });

  it("retries an adoption refused by an opt-out that landed mid-adoption", async () => {
    // Adoption checks suppression AFTER awaiting the active provider's
    // accounts. An opt-out that lands during that await refuses an
    // adoption that looked allowed when registration started; the refusal
    // itself must record the provider, or nothing ever retries it.
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();
    // A is active. Make its eth_accounts slow so B's adoption parks on it.
    const realRequest = a.request;
    a.request = async (args: { method: string }) =>
      args.method === "eth_accounts"
        ? new Promise((r) => setTimeout(() => r(realRequest(args)), 40))
        : realRequest(args);

    const b = makeWcProvider({ accounts: [OTHER], peer: "Rainbow" });
    expect(formo.registerProvider(b)).to.equal(true);
    formo.optOutTracking();
    await settle(80);
    expect(
      sent.filter((e) => e.type === "connect" && e.address?.toLowerCase() === OTHER.toLowerCase()),
      "refused while opted out"
    ).to.deep.equal([]);

    formo.optInTracking();
    await settle(80);
    expect(
      sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === OTHER.toLowerCase()),
      "adopted after opt-in"
    ).to.equal(true);
    formo.cleanup?.();
  });

  it("retries a session that connected via `connect` alone while on an excluded path", async () => {
    // Registered before pairing, so nothing to adopt; the wallet then
    // connects while the route is excluded and signals only `connect`
    // (eth_accounts answers), never `accountsChanged`. That refusal must
    // be recorded too, or the session is invisible until it signals again.
    const { formo, sent } = await setup({ tracking: { excludePaths: ["/"] } });
    const provider = makeWcProvider({ peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(true);
    await settle();
    provider.accounts = [ADDR];
    provider.emit("connect", { chainId: "0x1" });
    await settle();
    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);

    (global as any).window.history.pushState({}, "", "/app");
    await formo.page();
    await settle(60);

    expect(
      sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === ADDR.toLowerCase()),
      "connect-only session adopted after leaving the excluded path"
    ).to.equal(true);
    formo.cleanup?.();
  });

  it("retries a connect-only session that arrived on an excluded path while another wallet was active", async () => {
    // The connect handler adopts only the ACTIVE provider; a registered
    // provider connecting behind another wallet never reaches its
    // suppressed commit. The refusal must be noted on entry instead.
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup({ tracking: { excludePaths: ["/admin"] } });
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();
    const b = makeWcProvider({ peer: "Rainbow" });
    expect(formo.registerProvider(b)).to.equal(true);
    await settle();

    (global as any).window.history.pushState({}, "", "/admin");
    b.accounts = [OTHER];
    b.emit("connect", { chainId: "0x1" });
    await settle();
    expect(
      sent.filter((e) => e.type === "connect" && e.address?.toLowerCase() === OTHER.toLowerCase())
    ).to.deep.equal([]);

    (global as any).window.history.pushState({}, "", "/app");
    await formo.page();
    await settle(60);

    expect(
      sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === OTHER.toLowerCase()),
      "B adopted once the route is allowed"
    ).to.equal(true);
    formo.cleanup?.();
  });

  it("retries a second registered wallet whose accounts arrived while opted out", async () => {
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();

    formo.optOutTracking();
    const b = makeWcProvider({ accounts: [OTHER], peer: "Rainbow" });
    expect(formo.registerProvider(b)).to.equal(true);
    await settle();
    expect(
      sent.filter((e) => e.type === "connect" && e.address?.toLowerCase() === OTHER.toLowerCase())
    ).to.deep.equal([]);

    formo.optInTracking();
    await settle(80);
    expect(
      sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === OTHER.toLowerCase()),
      "B adopted after opt-in"
    ).to.equal(true);
    formo.cleanup?.();
  });

  it("adopts a connect-only session on the next page hit when connect autocapture is off", async () => {
    // With autocapture.connect off the SDK installs a chain-only observer
    // in place of the connect handler, so a wallet that signals `connect`
    // alone never reaches adoption. The registered provider exposes its
    // accounts synchronously; the next page hit must read them.
    const { formo, sent } = await setup({
      tracking: true,
      autocapture: { connect: false, signature: true },
    });
    const provider = makeWcProvider({ peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(true);
    await settle();
    provider.accounts = [ADDR];
    provider.emit("connect", { chainId: "0x1" });
    await settle();
    expect(formo.currentAddress, "not learned from connect alone").to.equal(undefined);

    await formo.page();
    await settle(60);

    expect(formo.currentAddress?.toLowerCase()).to.equal(ADDR.toLowerCase());
    expect(sent.filter((e) => e.type === "connect"), "connect autocapture is off").to.deep.equal([]);
    formo.cleanup?.();
  });

  it("keeps a still-connected registered wallet adoptable after the restored active one disconnects", async () => {
    // Two registered wallets, B active. Opt-out purges identity and marks
    // both pending; opt-in re-learns B and ignores A (another wallet is
    // active). A must stay pending: when B later disconnects and A
    // signals nothing, the next page hit is the only way to learn A.
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const b = makeWcProvider({ accounts: [OTHER], peer: "Rainbow" });
    const { formo, sent } = await setup();
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();
    expect(formo.registerProvider(b)).to.equal(true);
    await settle();
    expect(formo.currentAddress?.toLowerCase()).to.equal(OTHER.toLowerCase());

    formo.optOutTracking();
    await settle();
    formo.optInTracking();
    await settle(80);
    expect(formo.currentAddress?.toLowerCase(), "B restored").to.equal(OTHER.toLowerCase());

    b.accounts = [];
    b.emit("accountsChanged", []);
    await settle();
    expect(formo.currentAddress, "B gone").to.equal(undefined);
    sent.length = 0;

    await formo.page();
    await settle(80);

    expect(formo.currentAddress?.toLowerCase(), "A learned").to.equal(ADDR.toLowerCase());
    expect(sent.some((e) => e.type === "connect" && e.address?.toLowerCase() === ADDR.toLowerCase())).to.equal(true);
    formo.cleanup?.();
  });

  it("leaves a merely connected registered wallet alone while another wallet is active", async () => {
    // Opt-in re-learns B (active) and leaves A pending, ignored. A never
    // signalled; replaying it on a later page hit would be reported as a
    // switch nobody made. It waits until B is gone.
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const b = makeWcProvider({ accounts: [OTHER], peer: "Rainbow" });
    const { formo, sent } = await setup();
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();
    expect(formo.registerProvider(b)).to.equal(true);
    await settle();
    formo.optOutTracking();
    await settle();
    formo.optInTracking();
    await settle(80);
    expect(formo.currentAddress?.toLowerCase(), "B restored").to.equal(OTHER.toLowerCase());
    sent.length = 0;

    await formo.page();
    await settle(80);
    await formo.page();
    await settle(80);

    expect(sent.filter((e) => e.type === "connect" || e.type === "disconnect")).to.deep.equal([]);
    expect(formo.currentAddress?.toLowerCase(), "still B").to.equal(OTHER.toLowerCase());
    formo.cleanup?.();
  });

  it("settles a refused session that turns out to be the active wallet's own address", async () => {
    // B's session (refused while opted out) has the same address as the
    // active wallet A. The replay is ignored by design; it must also be
    // settled, or every later page hit replays it again and probes A's
    // accounts over the wallet transport.
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();

    formo.optOutTracking();
    const b = makeWcProvider({ accounts: [ADDR], peer: "Rainbow" });
    expect(formo.registerProvider(b)).to.equal(true);
    await settle();
    formo.optInTracking();
    await settle(80);
    expect(formo.currentAddress?.toLowerCase()).to.equal(ADDR.toLowerCase());

    const probes = sandbox.spy(a, "request");
    sent.length = 0;
    await formo.page();
    await settle(80);
    await formo.page();
    await settle(80);

    expect(
      probes.getCalls().filter((c) => c.args[0]?.method === "eth_accounts").length,
      "no eth_accounts probe on the active wallet from a page hit"
    ).to.equal(0);
    expect(sent.filter((e) => e.type === "connect" || e.type === "disconnect")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("re-adopts a registered wallet that disconnects and reconnects with connect alone", async () => {
    // Adopted once, settled. Its session ends, then a new one announces
    // itself with `connect` only while connect autocapture is off, which
    // no handler adopts. The session end must reopen the pending entry.
    const { formo } = await setup({
      tracking: true,
      autocapture: { connect: false, signature: true },
    });
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(true);
    await settle();
    expect(formo.currentAddress?.toLowerCase()).to.equal(ADDR.toLowerCase());

    provider.accounts = [];
    provider.emit("accountsChanged", []);
    await settle();
    expect(formo.currentAddress, "session ended").to.equal(undefined);

    provider.accounts = [OTHER];
    provider.emit("connect", { chainId: "0x1" });
    await settle();
    expect(formo.currentAddress, "connect alone adopts nothing").to.equal(undefined);

    await formo.page();
    await settle(60);
    expect(formo.currentAddress?.toLowerCase(), "re-adopted on the page hit").to.equal(OTHER.toLowerCase());
    formo.cleanup?.();
  });

  it("does not re-adopt already adopted providers on every page hit", async () => {
    // Adoption is the accountsChanged path, and that path treats a provider
    // with a different address from the active one as a wallet switch. Two
    // registered providers therefore produced a disconnect and a connect
    // on EVERY page hit, with no user action behind either.
    const a = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const b = makeWcProvider({ accounts: [OTHER], peer: "Rainbow" });
    const { formo, sent } = await setup();
    expect(formo.registerProvider(a)).to.equal(true);
    await settle();
    expect(formo.registerProvider(b)).to.equal(true);
    await settle();
    // Real switches: A reported, B replaces it, the user goes back to A.
    a.emit("accountsChanged", [ADDR]);
    await settle();
    expect(sent.filter((e) => e.type === "connect").length, "A, B, A").to.equal(3);
    sent.length = 0;

    await formo.page();
    await settle(60);
    await formo.page();
    await settle(60);

    expect(
      sent.filter((e) => e.type === "connect" || e.type === "disconnect"),
      "no lifecycle events from a page hit"
    ).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("attributes signatures and transactions to the wallet behind the transport", async () => {
    // The live-test rows had provider_name EMPTY on every signature and
    // transaction; per-wallet activity was unanswerable in the warehouse.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();
    formo.registerProvider(provider);
    await settle();
    sent.length = 0;

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    const sig = sent.find((e) => e.type === "signature");
    expect(sig?.properties?.providerName).to.equal(PEER);
    expect(sig?.properties?.rdns).to.equal("com.walletconnect");
    formo.cleanup?.();
  });

  it("refuses in wagmi mode, where the connector system already tracks the session", async () => {
    const wagmiConfig: any = {
      subscribe: () => () => undefined,
      getState: () => ({ status: "disconnected", connections: new Map(), current: undefined, chainId: undefined }),
      state: { status: "disconnected", connections: new Map(), current: undefined, chainId: undefined },
    };
    const { formo, sent } = await setup({ tracking: true, wagmi: { config: wagmiConfig } });

    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    expect(formo.registerProvider(provider)).to.equal(false);
    await settle();

    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("reports failure for a provider the wrapper cannot instrument", async () => {
    // Wrapping reassigns provider.request, so a frozen provider
    // deterministically defeats it. Claiming success while its requests
    // stay invisible would recreate the very silent loss this API exists
    // to close - and the partial registration must unwind: no adopted
    // session, and no listeners left behind holding the instance.
    const provider = Object.freeze(makeWcProvider({ accounts: [ADDR], peer: PEER }));
    const { formo, sent } = await setup();

    expect(formo.registerProvider(provider)).to.equal(false);
    await settle();

    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("survives a later EIP-6963 announcement without losing the registration", async () => {
    // The P1 from review: announcement-driven cleanup untracked anything
    // absent from the announcement list, and a registered provider is
    // never announced. Its absence is its normal state, not removal.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const { formo, sent } = await setup();
    formo.registerProvider(provider);
    await settle();

    const announced = makeWcProvider({});
    (announced as any).isMetaMask = true;
    (global as any).window.dispatchEvent(
      new (global as any).CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({
          info: { uuid: "11111111-2222-4333-8444-555555555555", name: "MetaMask", icon: "data:image/svg+xml;base64,", rdns: "io.metamask" },
          provider: announced,
        }),
      })
    );
    await settle();

    // The registered provider still tracks: its signature still captures.
    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();
    expect(sent.filter((e) => e.type === "signature").length, "requested + confirmed").to.equal(2);
    formo.cleanup?.();
  });

  it("refuses a provider whose setter swallows the wrapper", async () => {
    // An accessor that accepts `provider.request = ...` without storing it
    // defeats the wrapper silently. Success must mean capture works, so
    // the install reads the property back.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const native = provider.request;
    Object.defineProperty(provider, "request", {
      get: () => native,
      set: () => undefined, // swallowed
      configurable: false,
    });
    const { formo, sent } = await setup();

    expect(formo.registerProvider(provider)).to.equal(false);
    await settle();
    expect(sent.filter((e) => e.type === "connect")).to.deep.equal([]);
    formo.cleanup?.();
  });

  it("instruments exactly once through layered wrappers after a rebuild", async () => {
    // Another library wraps OUR wrapper, then the SDK rebuilds and wraps
    // the outer function (the marker is not on it). Both layers route to
    // the same live tracker; without the in-flight guard one user request
    // produced doubled events.
    const provider = makeWcProvider({ accounts: [ADDR], peer: PEER });
    const a = await setup();
    a.formo.registerProvider(provider);
    await settle();

    // A third-party wrapper chains through ours.
    const formoWrapped = provider.request;
    provider.request = (args: unknown) => (formoWrapped as any)(args);

    a.formo.cleanup?.();
    const b = await setup();
    expect(b.formo.registerProvider(provider)).to.equal(true);
    await settle();
    b.sent.length = 0;

    await provider.request({ method: "personal_sign", params: ["0x68", ADDR] });
    await settle();

    expect(
      b.sent.filter((e) => e.type === "signature").length,
      "one request, one requested + one confirmed"
    ).to.equal(2);
    b.formo.cleanup?.();
  });

  it("refuses an object that is not an EIP-1193 provider", async () => {
    const { formo } = await setup();
    expect(formo.registerProvider({} as any)).to.equal(false);
    formo.cleanup?.();
  });
});
