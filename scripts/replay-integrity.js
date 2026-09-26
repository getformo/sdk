// Writes the sha384 of dist/replay.umd.min.js into the built core files, in
// place of the token in src/replay/loadBundle.ts. Runs at the end of
// `pnpm build`, so the published core only ever loads the replay bundle
// published with it. Fails the build if any file does not hold the token
// exactly once.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOKEN = "__FORMO_REPLAY_BUNDLE_INTEGRITY__";
const dist = path.join(__dirname, "..", "dist");

const bundle = fs.readFileSync(path.join(dist, "replay.umd.min.js"));
const integrity =
  "sha384-" + crypto.createHash("sha384").update(bundle).digest("base64");

const targets = [
  "index.umd.min.js",
  "cjs/src/replay/loadBundle.js",
  "esm/src/replay/loadBundle.js",
];

for (const target of targets) {
  const file = path.join(dist, target);
  const source = fs.readFileSync(file, "utf8");
  const count = source.split(TOKEN).length - 1;
  if (count !== 1) {
    throw new Error(`${target}: expected the integrity token once, found ${count}`);
  }
  fs.writeFileSync(file, source.replace(TOKEN, integrity));
}

console.log(`replay bundle integrity ${integrity}`);
