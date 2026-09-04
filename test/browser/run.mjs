// Headless browser E2E for the built SDK. Zero dependencies beyond Node and a
// local Chrome: drives the page over the DevTools protocol with the built-in
// WebSocket, so nothing is added to the SDK's dependency tree.
//
// Usage: node test/browser/run.mjs   (expects anvil on :8545 and a built dist/)
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

if (typeof WebSocket === "undefined") {
  // The global is on by default from Node 22.4. On 20.10 to 22.3 it exists
  // only behind --experimental-websocket, which this check does not try.
  console.error("test:browser needs Node >= 22.4 (built-in WebSocket)");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const sdkPath = join(root, "dist/index.umd.min.js");

// ── static server for the harness page ───────────────────────────────────
// Serves a fixed allowlist by name, so a request path can never reach anything
// else on disk. Bound to loopback only.
const files = {
  "/harness.html": readFileSync(join(here, "harness.html")),
  "/storage-parent.html": readFileSync(join(here, "storage-parent.html")),
  "/storage-frame.html": readFileSync(join(here, "storage-frame.html")),
  "/sdk.js": readFileSync(sdkPath),
};
const server = createServer((req, res) => {
  const path = req.url === "/" ? "/harness.html" : req.url.split("?")[0];
  const body = Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
  if (!body) { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── headless chrome over CDP ─────────────────────────────────────────────
const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome", "chromium", "chrome"]
  .find((c) => { try { execSync(`test -x "${c}" || command -v ${c}`, { stdio: "ignore" }); return true; } catch { return false; } });
if (!chrome) { console.error("no chrome found"); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), "formo-e2e-"));
let proc, ws;
const teardown = () => {
  try { ws?.close(); } catch {}
  try { proc?.kill(); } catch {}
  try { server.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on("exit", teardown);
// A hung page must not hang CI: every await below is bounded by this.
const deadline = setTimeout(() => { console.error("test:browser timed out after 90s"); process.exit(3); }, 90_000);
deadline.unref();
proc = spawn(chrome, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--disable-gpu",
  // Exercise the SDK's third-party fallback deterministically even on Chrome
  // channels where the cookie phase-out is not enabled by default yet.
  "--test-third-party-cookie-phaseout",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve) => { proc.stderr.on("data", (d) => { const m = String(d).match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); }); });
ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result.result.value;
};
await send("Page.enable", {}, sessionId);
const navigate = async (url) => {
  const loaded = new Promise((r) => { const h = (m) => { const j = JSON.parse(m.data); if (j.method === "Page.loadEventFired" && j.sessionId === sessionId) { ws.removeEventListener("message", h); r(); } }; ws.addEventListener("message", h); });
  await send("Page.navigate", { url }, sessionId);
  await loaded;
};
await navigate(`http://127.0.0.1:${port}/harness.html`);
await evaluate("window.__ready.then(() => true)");

// ── the scenario ─────────────────────────────────────────────────────────
const A = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf", B = "0x88C0224CEABF6D559d7B622F2918b308285280DE";
const step = async (name, js, waitMs = 400) => {
  const out = await evaluate(`(async () => { const f = await window.__ready; const m = window.__sent.length;
    ${js || "void 0"};
    await new Promise(r => setTimeout(r, ${waitMs}));
    return window.__sent.slice(m).map(e => e.type + (e.properties?.status ? ":" + e.properties.status : "") + "@" + (e.properties?.chain_id ?? "-") + "/" + (e.address ? e.address.slice(0,6) : "-"))
      // The SDK debounces page hits 300ms to coalesce SPA navigations, so
      // WHICH step's window the ambient page event lands in depends on
      // runner speed - the first CI run proved it (page fired during init
      // there, after connect locally). Wallet events are what this suite
      // asserts; page behaviour has its own deterministic coverage in the
      // api-mode e2e behaviours.
      .filter(x => !x.startsWith("page@")); })()`);
  return [name, out];
};
const results = [];
results.push(await step("init", "", 200));
results.push(["discovered", await evaluate("window.__ready.then(f => f.evm.all.map(d => d.info.rdns))")]);
results.push(await step("connect A",        "await window.__walletA.request({ method: 'eth_requestAccounts' })"));
results.push(await step("sign (A)",         "await window.__walletA.request({ method: 'personal_sign', params: ['0x68656c6c6f', '" + A + "'] })"));
results.push(await step("reject sign (A)",  "window.__rejectNext = true; await window.__walletA.request({ method: 'personal_sign', params: ['0x68', '" + A + "'] }).catch(() => {})"));
// Wallets start on 0x7a69, so switch AWAY and back: a switch to the current chain is a no-op in a real wallet and proves nothing.
results.push(await step("switch chain",     "await window.__walletA.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }); await window.__walletA.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] })"));
results.push(await step("send tx (A)",      "await window.__walletA.request({ method: 'eth_sendTransaction', params: [{ from: '" + A + "', to: '" + B + "', value: '0x1' }] })", 4500));
results.push(await step("batch 2 calls (A)","await window.__walletA.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from: '" + A + "', chainId: '0x7a69', calls: [{ to: '" + B + "', value: '0x1' }, { to: '" + B + "', value: '0x2' }] }] })", 4500));
results.push(await step("switch to B",      "window.__walletB.__setAccounts(['" + B + "'])"));
results.push(await step("sign on B",        "await window.__walletB.request({ method: 'personal_sign', params: ['0x68', '" + B + "'] })"));
results.push(await step("disconnect B",     "window.__walletB.__disconnect()"));
results.push(["sdk-issued rpc", await evaluate("(window.__rpc||[]).filter(m => !/personal_sign|eth_sendTransaction|wallet_sendCalls|wallet_switchEthereumChain|eth_requestAccounts/.test(m))")]);
results.push(["hasBuffer", await evaluate("typeof Buffer !== 'undefined'")]);

// A different hostname makes the frame cross-site while both origins still
// resolve to this loopback-only server. The frame is destroyed and recreated,
// which discards the bundle's module memory and proves persistence comes from
// partitioned Web Storage rather than the page-lifetime fallback.
await navigate(`http://localhost:${port}/storage-parent.html?framePort=${port}`);
const storage = await evaluate("window.__storageDone");
results.push(["cross-origin storage", {
  cookieBlocked: storage.first.cookie === "" && storage.second.cookie === "",
  oneIdPerLoad:
    storage.first.ids.length === 2 &&
    storage.second.ids.length === 2 &&
    new Set(storage.first.ids).size === 1 &&
    new Set(storage.second.ids).size === 1,
  stableAcrossReload: storage.first.ids[0] === storage.second.ids[0],
  persistedInLocalStorage:
    storage.first.localId === storage.first.ids[0] &&
    storage.second.localId === storage.first.ids[0],
}]);

// ── assertions ───────────────────────────────────────────────────────────
// Exact expectations, not "non-empty": the point is to catch a missing or
// duplicated event, which is the shape of every bug in this sequence.
const expect = {
  "discovered":        ["io.metamask", "io.rabby"],
  "connect A":         ["connect@31337/0x5137"],
  "sign (A)":          ["signature:requested@31337/0x5137", "signature:confirmed@31337/0x5137"],
  "reject sign (A)":   ["signature:requested@31337/0x5137", "signature:rejected@31337/0x5137"],
  "switch chain":      ["chain@1/0x5137", "chain@31337/0x5137"],
  "send tx (A)":       ["transaction:started@31337/0x5137", "transaction:broadcasted@31337/0x5137", "transaction:confirmed@31337/0x5137"],
  "batch 2 calls (A)": ["transaction:started@31337/0x5137", "transaction:started@31337/0x5137", "transaction:broadcasted@31337/0x5137", "transaction:broadcasted@31337/0x5137", "transaction:confirmed@31337/0x5137", "transaction:confirmed@31337/0x5137"],
  "switch to B":       ["disconnect@31337/0x5137", "connect@31337/0x88C0"],
  "sign on B":         ["signature:requested@31337/0x88C0", "signature:confirmed@31337/0x88C0"],
  "disconnect B":      ["disconnect@31337/0x88C0"],
  "hasBuffer":         false,
  "cross-origin storage": {
    cookieBlocked: true,
    oneIdPerLoad: true,
    stableAcrossReload: true,
    persistedInLocalStorage: true,
  },
};
let failed = 0;
for (const [k, v] of results) {
  const want = expect[k];
  const ok = want === undefined || JSON.stringify(v) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${k.padEnd(18)} ${JSON.stringify(v)}${ok ? "" : "\n       want " + JSON.stringify(want)}`);
}
// The SDK must never put an analytics-only probe on a wallet's transport. Only
// eth_accounts and the receipt/status polls are allowed.
const rpc = results.find(([k]) => k === "sdk-issued rpc")[1];
const disallowed = rpc.filter((m) => !/:(eth_accounts|eth_getTransactionReceipt|wallet_getCallsStatus)$/.test(m));
if (disallowed.length) { failed++; console.log(`  FAIL sdk issued disallowed rpc: ${JSON.stringify(disallowed)}`); }
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
