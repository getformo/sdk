// Backwards-compatibility harness.
// Drives a BUILT Formo SDK against a REAL wagmi store + a real TanStack
// QueryClient, taken from an example app's own node_modules, and prints every
// event the SDK would have sent as JSON.
//
// Usage: node harness.mjs <sdkPackageDir> <exampleDir> <mode>
//   sdkPackageDir = a directory containing the SDK's package.json and dist/
//                   (an installed node_modules/@formo/analytics works)
//   mode = wagmi | eip1193 | cold | unknownchain | twowallets
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

import { resolve as _resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [, , SDK_DIR_R, EXAMPLE_DIR_R, MODE] = process.argv;
const SDK_DIR = _resolve(SDK_DIR_R);
const EXAMPLE_DIR = _resolve(EXAMPLE_DIR_R);
let req = createRequire(EXAMPLE_DIR + "/package.json");
// `@wagmi/core` and `@tanstack/query-core` are transitive deps of `wagmi` /
// `@tanstack/react-query`, so they are not resolvable from the app root under
// pnpm's strict layout. Re-root the require at the package that owns them.
function reqFrom(pkg, fallback) {
  try { return createRequire(req.resolve(pkg + "/package.json")); }
  catch { try { return createRequire(req.resolve(pkg)); } catch { return fallback; } }
}
const coreReq = reqFrom("wagmi", req);
const qReq = reqFrom("@tanstack/react-query", req);
const sdkReq = createRequire(SDK_DIR + "/package.json");

// --- DOM ---------------------------------------------------------------
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/",
});
for (const k of ["window", "document", "location", "navigator", "localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? dom.window : dom.window[k], writable: true, configurable: true,
  });
}
globalThis.self = dom.window;
// Node's own Event/CustomEvent are a different realm than jsdom's.
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
if (!globalThis.crypto?.randomUUID) {
  globalThis.crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000000" };
}

// --- capture every outbound event --------------------------------------
const sent = [];
globalThis.fetch = async (url, init) => {
  try {
    const body = JSON.parse(init?.body ?? "{}");
    if (process.env.E2E_RAW) console.error("RAW " + JSON.stringify(body).slice(0, 900));
    for (const e of Array.isArray(body) ? body : [body]) {
      const pr = e.properties ?? {};
      sent.push({ type: e.type ?? e.event ?? e.action, event: e.type === "track" ? e.event : undefined, userId: e.user_id ?? e.userId, address: e.address, chainId: pr.chain_id ?? e.chain_id, status: pr.status, path: e.type === "page" ? pr.path ?? e.context?.page?.path : undefined });
    }
  } catch { /* non-JSON */ }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};
globalThis.navigator.sendBeacon = () => true;

const { FormoAnalytics } = sdkReq(SDK_DIR + "/dist/cjs/src/index.js");

const ADDR_A = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
const ADDR_B = "0x88C0224CEABF6D559d7B622F2918b308285280DE";

const log = [];
const rec = (label) => {
  log.push({ step: label, events: sent.splice(0).map(e => `${e.type}${e.status ? ":" + e.status : ""}${e.event ? "(" + e.event + ")" : ""}@${e.chainId ?? "-"}${process.env.E2E_ADDR ? "/" + (e.address ?? "-").slice(0, 6) : ""}${e.userId ? "#" + e.userId : ""}`) });
};
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

// --- a scriptable EIP-1193 provider ------------------------------------
function makeProvider({ chainId = 1, accounts = [ADDR_A], exposeChainId = true, chainIdFails = false } = {}) {
  const handlers = {};
  const p = {
    ...(exposeChainId ? { chainId: "0x" + chainId.toString(16) } : {}),
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); if (process.env.E2E_DBG) console.error("SDK subscribed:", ev); },
    removeListener: (ev, fn) => { handlers[ev] = (handlers[ev] ?? []).filter(f => f !== fn); },
    request: async ({ method }) => {
      if (method === "eth_chainId") { p.rpcCalls.push(method); if (chainIdFails) throw new Error("chain unavailable"); return "0x" + chainId.toString(16); }
      if (method === "eth_accounts" || method === "eth_requestAccounts") { p.rpcCalls.push(method); return accounts; }
      p.rpcCalls.push(method);
      if (method === "personal_sign" || method === "eth_signTypedData_v4") return "0xsigned";
      if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
      if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x1" };
      return null;
    },
    rpcCalls: [],
    emit: (ev, ...a) => { if (process.env.E2E_DBG) console.error("emit", ev, "->", (handlers[ev]??[]).length, "listener(s)"); return (handlers[ev] ?? []).forEach(f => f(...a)); },
    setChain: (c) => { chainId = c; if (exposeChainId) p.chainId = "0x" + c.toString(16); },
  };
  return p;
}


// EIP-6963: how a real wallet makes itself discoverable. Without this the SDK
// only sees window.ethereum and does not wire its lifecycle listeners.
function announce6963(provider, info = {}) {
  const detail = Object.freeze({
    info: {
      uuid: "11111111-2222-4333-8444-555555555555",
      name: "E2E Wallet",
      icon: "data:image/svg+xml;base64,",
      rdns: "com.e2e.wallet",
      ...info,
    },
    provider,
  });
  dom.window.dispatchEvent(
    new dom.window.CustomEvent("eip6963:announceProvider", { detail })
  );
}

async function runEip1193(opts) {
  const provider = makeProvider(opts.provider ?? {});
  globalThis.window.ethereum = provider;
  announce6963(provider);
  const formo = await FormoAnalytics.init("wk_e2e", { tracking: true, flushAt: 1, flushInterval: 10, ...opts.sdk });
  await settle();
  announce6963(provider);   // and again, for a listener that mounted late
  await settle();
  rec("init");

  provider.emit("connect", { chainId: "0x1" });
  provider.emit("accountsChanged", [ADDR_A]);
  await settle(); rec("connect");

  provider.setChain(137);
  provider.emit("chainChanged", "0x89");
  await settle(); rec("chainSwitch");

  await provider.request({ method: "personal_sign", params: ["0x6869", ADDR_A] });
  await settle(); rec("signature");

  await provider.request({ method: "eth_sendTransaction", params: [{ from: ADDR_A, to: ADDR_B, value: "0x0", data: "0x" }] });
  await settle(120); rec("transaction");

  provider.emit("accountsChanged", []);
  await settle(); rec("disconnect");

  formo.cleanup?.();
  return { log, rpcCalls: provider.rpcCalls };
}

async function runWagmi(opts) {
  // These ship as ESM, so import by resolved file URL rather than require.
  const wagmiReq = reqFrom("wagmi", req);
  const coreEntry = wagmiReq.resolve("@wagmi/core");
  const coreDir = coreEntry.split("/dist/")[0];
  const { createConfig, http, connect, disconnect, switchChain } =
    await import(pathToFileURL(coreEntry).href);
  // The mock connector has no exports-map entry; reach it by file path.
  const { mock } = await import(
    pathToFileURL(coreDir + "/dist/esm/connectors/mock.js").href
  );
  const { mainnet, polygon } = await import(
    pathToFileURL(req.resolve("viem/chains")).href
  );
  const { QueryClient } = qReq("@tanstack/query-core");

  const connector = mock({ accounts: [ADDR_A, ADDR_B], features: { defaultConnected: false } });
  const config = createConfig({
    chains: [mainnet, polygon],
    connectors: [connector],
    transports: { [mainnet.id]: http(), [polygon.id]: http() },
  });
  const queryClient = new QueryClient();

  if (opts.preConnect) { await connect(config, { connector }); await settle(); }

  const formo = await FormoAnalytics.init("wk_e2e", {
    tracking: true, flushAt: 1, flushInterval: 10, wagmi: { config, queryClient }, ...opts.sdk,
  });
  await settle(); rec(opts.preConnect ? "init(already connected)" : "init");

  if (!opts.preConnect) { await connect(config, { connector }); await settle(); rec("connect"); }

  await switchChain(config, { chainId: polygon.id }); await settle(); rec("chainSwitch");

  // Imperative mutation through the MutationCache ("path 13").
  const mc = queryClient.getMutationCache();
  const sigMutation = mc.build(queryClient, {
    mutationKey: ["signMessage"],
    mutationFn: async () => "0xsigned",
  });
  await sigMutation.execute({ message: "hi" });
  await settle(); rec("signature");

  const txMutation = mc.build(queryClient, {
    mutationKey: ["sendTransaction"],
    mutationFn: async () => "0x" + "cd".repeat(32),
  });
  await txMutation.execute({ to: ADDR_B, value: 0n });
  await settle(); rec("transaction");

  if (opts.accountSwitch) {
    // Switch account inside the already-connected wallet. Wagmi keeps
    // `status: "connected"` and only the connection's accounts change.
    // Exactly what wagmi's own `change()` handler does for an
    // `accountsChanged` from the connector: replace the connection with a new
    // object whose accounts lead with the newly selected one.
    const store = config._internal.store;
    store.setState((x) => {
      const conn = x.connections.get(x.current);
      return {
        ...x,
        connections: new Map(x.connections).set(x.current, {
          accounts: [ADDR_B, ADDR_A],
          chainId: conn.chainId,
          connector: conn.connector,
        }),
      };
    });
    await settle();
    if (process.env.E2E_DBG) {
      const st = config.state;
      const cur = st.connections.get(st.current);
      console.error("after switch: current accounts =", cur?.accounts);
    }
    rec("accountSwitch");

    const switchedSig = mc.build(queryClient, {
      mutationKey: ["signMessage"],
      mutationFn: async () => "0xsigned",
    });
    await switchedSig.execute({ message: "after switch" });
    await settle(); rec("signAfterSwitch");
  }

  if (opts.explicitAccount) {
    // A mutation that names a different account than the active one.
    const explicitSig = mc.build(queryClient, {
      mutationKey: ["signMessage"],
      mutationFn: async () => "0xsigned",
    });
    await explicitSig.execute({ message: "explicit", account: ADDR_B });
    await settle(); rec("signExplicitAccount");
  }

  await disconnect(config); await settle(); rec("disconnect");

  formo.cleanup?.();
  return { log };
}

const opts = JSON.parse(process.env.E2E_OPTS || "{}");
// A provider that announces nothing: no connect, no chainChanged, no
// synchronous chainId. The dapp just signs. This is where the chain is
// genuinely unresolvable.
/**
 * A wallet whose chain is never announced. "cold" exposes no synchronous
 * chainId; "unknownchain" additionally fails eth_chainId, so the SDK must
 * report 0 rather than guess. Same flow, one knob.
 */
async function runNoChain(opts, providerOpts) {
  const provider = makeProvider({ exposeChainId: false, ...providerOpts, ...(opts.provider ?? {}) });
  globalThis.window.ethereum = provider;
  const formo = await FormoAnalytics.init("wk_e2e", { tracking: true, flushAt: 1, flushInterval: 10, ...opts.sdk });
  await settle(); rec("init");

  // Address becomes known without any chain being announced.
  provider.emit("accountsChanged", [ADDR_A]);
  await settle(); rec("accountsChanged");

  await provider.request({ method: "personal_sign", params: ["0x6869", ADDR_A] });
  await settle(); rec("signature");

  await provider.request({ method: "eth_sendTransaction", params: [{ from: ADDR_A, to: ADDR_B, value: "0x0", data: "0x" }] });
  await settle(120); rec("transaction");

  formo.cleanup?.();
  return { log, rpcCalls: provider.rpcCalls };
}
const runCold = (opts) => runNoChain(opts, {});
const runUnknownChain = (opts) => runNoChain(opts, { chainIdFails: true });

// Two installed wallets. The visitor signs through the one that is NOT the
// active provider - the case where main issues an in-request `eth_chainId`
// on that wallet's own transport.
async function runTwoWallets(opts) {
  const active = makeProvider({ chainId: 1, ...(opts.provider ?? {}) });
  const other = makeProvider({ chainId: 137, exposeChainId: !!(opts.otherAnnounces) });
  globalThis.window.ethereum = active;
  announce6963(active);
  const formo = await FormoAnalytics.init("wk_e2e", { tracking: true, flushAt: 1, flushInterval: 10, ...opts.sdk });
  await settle();

  // The active wallet connects.
  active.emit("connect", { chainId: "0x1" });
  active.emit("accountsChanged", [ADDR_A]);
  await settle(); rec("activeConnects");

  // The second wallet is discovered but never becomes active.
  announce6963(other, { uuid: "22222222-3333-4444-8555-666666666666", rdns: "com.e2e.other" });
  if (opts.otherAnnounces) other.emit("chainChanged", "0x89");
  await settle();
  other.rpcCalls.length = 0;   // only count what the signature costs
  rec("otherDiscovered");

  await other.request({ method: "personal_sign", params: ["0x6869", ADDR_A] });
  await settle(); rec("signViaOther");

  formo.cleanup?.();
  return { log, rpcCalls: other.rpcCalls };
}


// The public API and consent, on an EIP-1193 provider. Covers what the
// wallet-event modes cannot: identify, track, reset, opt-out/opt-in, and the
// active-wallet cookie surviving a reload.
async function runApi(opts) {
  const provider = makeProvider(opts.provider ?? {});
  globalThis.window.ethereum = provider;
  announce6963(provider);
  const formo = await FormoAnalytics.init("wk_e2e", { tracking: true, flushAt: 1, flushInterval: 10, ...opts.sdk });
  await settle(); rec("init");

  provider.emit("connect", { chainId: "0x1" });
  provider.emit("accountsChanged", [ADDR_A]);
  await settle(); rec("connect");

  await formo.identify({ address: ADDR_A, userId: "user-1" });
  await settle(); rec("identify");

  // A second identify for the same wallet is deduped within the session.
  await formo.identify({ address: ADDR_A, userId: "user-1" });
  await settle(); rec("identifyAgain");

  // Let the location-change page hit (300ms debounce) drain first, so the
  // explicit page() below is asserted on its own.
  await settle(400); sent.length = 0;
  await formo.track("checkout_started", { plan: "pro", seats: 3 });
  await settle(); rec("track");

  // page() is deliberately delayed 300ms inside the SDK to coalesce rapid
  // SPA navigations, so it needs a longer settle than the other calls.
  await formo.page("docs", "getting-started");
  await settle(450); rec("page");

  // Consent: nothing must go out while opted out, and tracking resumes after.
  formo.optOutTracking();
  await formo.track("while_opted_out");
  await provider.request({ method: "personal_sign", params: ["0x6869", ADDR_A] });
  await settle(); rec("optedOut");
  formo.optInTracking();
  await formo.track("after_opt_in");
  await settle(); rec("optedIn");

  // reset() clears identity: the next track carries no user or address.
  formo.reset();
  await formo.track("after_reset");
  await settle();
  const last = log.length;
  rec("afterReset");
  log[last].state = { address: formo.currentAddress ?? null, userId: formo.currentUserId ?? null };

  // A new instance on the same "page" must restore the wallet from the cookie
  // before any wallet event, so the first page hit carries the address.
  provider.emit("accountsChanged", [ADDR_A]);
  await settle();
  formo.cleanup?.();
  sent.length = 0;
  const again = await FormoAnalytics.init("wk_e2e", { tracking: true, flushAt: 1, flushInterval: 10, ...opts.sdk });
  await settle();
  const restored = { address: again.currentAddress ?? null, chainId: again.currentChainId ?? null };
  rec("reloadRestore");
  log[log.length - 1].state = restored;
  again.cleanup?.();
  return { log, rpcCalls: provider.rpcCalls };
}

const out = MODE === "api" ? await runApi(opts)
  : MODE === "twowallets" ? await runTwoWallets(opts)
  : MODE === "unknownchain" ? await runUnknownChain(opts)
  : MODE === "wagmi" ? await runWagmi(opts)
  : MODE === "cold" ? await runCold(opts)
  : await runEip1193(opts);
console.log(JSON.stringify(out, null, 0));
process.exit(0);
