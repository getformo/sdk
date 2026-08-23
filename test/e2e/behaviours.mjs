// Runs every scenario in scenarios.mjs and asserts its exact event lists.
//
// This is the BEHAVIOUR suite: one representative example per path, many
// configurations. sweep.mjs is the COMPATIBILITY suite: one configuration,
// every example. Together they answer different questions.
//
// Usage: node test/e2e/behaviours.mjs [filter]   (after npm run build)
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
// In the SDK repo the package under test is this checkout's own dist/, and
// wagmi/viem come from its devDependencies. No example app is involved.
const sdkDir = root;
const filter = process.argv[2];
const exampleFor = () => root;

// wagmi and viem are peer dependencies, not devDependencies: the SDK repo
// deliberately does not carry them. The wagmi rows therefore run only where
// real wagmi is installed - the examples repo, against the PUBLISHED package.
// Here they are skipped, loudly, so the count is never mistaken for coverage.
let hasWagmi = true;
try { await import("wagmi"); } catch { hasWagmi = false; }

let failed = 0, ran = 0, skipped = 0;
for (const sc of SCENARIOS) {
  if (filter && !sc.name.includes(filter)) continue;
  if (sc.mode === "wagmi" && !hasWagmi) { skipped++; continue; }
  ran++;
  const r = spawnSync("node", [join(here, "harness.mjs"), sdkDir, exampleFor(sc.mode), sc.mode], {
    encoding: "utf8", env: { ...process.env, E2E_ADDR: "1", E2E_OPTS: JSON.stringify(sc.opts ?? {}) },
  });
  let out;
  try { out = JSON.parse(r.stdout); } catch {
    failed++; console.log(`  FAIL ${sc.name}\n       harness crashed: ${(r.stderr || "").split("\n").find((l) => /Error/.test(l)) ?? "?"}`); continue;
  }
  // The SDK's page hit is debounced 300ms from init, so it lands in whichever
  // step happens to be running then. It is asserted on its own in the api
  // scenarios; everywhere else it is ambient and stripped before comparing.
  const strip = (events) => events.filter((e) => !/^page@/.test(e));
  const steps = Object.fromEntries(out.log.map((s) => [s.step, sc.mode === "api" ? s.events : strip(s.events)]));
  const states = Object.fromEntries(out.log.filter((s) => s.state).map((s) => [s.step, s.state]));
  const problems = [];

  for (const [step, want] of Object.entries(sc.expect ?? {})) {
    const got = step === "all"
      ? out.log.flatMap((s) => s.events).filter((e) => !e.startsWith("page") && !e.startsWith("detect"))
      : steps[step];
    if (got === undefined) { problems.push(`step "${step}" never ran`); continue; }
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${step}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  for (const [step, want] of Object.entries(sc.state ?? {})) {
    const got = states[step];
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${step} state: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  for (const m of sc.rpcMustNotInclude ?? []) {
    if ((out.rpcCalls ?? []).some((c) => String(c).includes(m))) problems.push(`SDK issued ${m} on the wallet's transport: ${JSON.stringify(out.rpcCalls)}`);
  }

  if (problems.length) { failed++; console.log(`  FAIL ${sc.name}`); for (const p of problems) console.log(`       ${p}`); }
  else console.log(`  ok   ${sc.name}`);
}
if (skipped) console.log(`\n  ${skipped} wagmi scenario(s) skipped: wagmi is a peer dependency and is not installed here. They run in the examples repo.`);
console.log(failed ? `\n${failed} of ${ran} scenario(s) failed` : `\nall ${ran} scenarios passed`);
process.exit(failed ? 1 : 0);
