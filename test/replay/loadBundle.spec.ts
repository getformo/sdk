import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { loadReplayBundle, replayBundleUrls } from "../../src/replay/loadBundle";
import { version } from "../../src/version";

/**
 * The core SDK's only replay code path that runs for CDN installs. jsdom
 * does not fetch scripts, so each test settles the injected tag by hand.
 */
describe("loadReplayBundle", () => {
  let jsdom: JSDOM;

  const scripts = () =>
    Array.from(jsdom.window.document.querySelectorAll("script")) as HTMLScriptElement[];

  /** Let the loader's promise chain reach its next script tag. */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com/",
    });
    for (const [k, v] of [
      ["window", jsdom.window],
      ["document", jsdom.window.document],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    jsdom.window.close();
  });

  it("points at this version's bundle on jsDelivr, then unpkg", () => {
    expect(replayBundleUrls()).to.deep.equal([
      `https://cdn.jsdelivr.net/npm/@formo/analytics@${version}/dist/replay.umd.min.js`,
      `https://unpkg.com/@formo/analytics@${version}/dist/replay.umd.min.js`,
    ]);
  });

  it("refuses the CDN when the build carries no integrity hash", async () => {
    // Source builds keep the token; scripts/replay-integrity.js replaces it.
    let error: Error | undefined;
    await loadReplayBundle().catch((e) => (error = e));
    expect(error?.message).to.include("no replay bundle integrity");
    expect(scripts()).to.have.length(0);
  });

  // One flow, because a successful load is cached for the page's lifetime.
  it("loads a custom scriptUrl without integrity, and retries after a failure", async () => {
    const failed = loadReplayBundle("https://self.example/replay.js");
    const [first] = scripts();
    expect(first.src).to.equal("https://self.example/replay.js");
    expect(first.getAttribute("integrity")).to.equal(null);
    first.onerror!(new jsdom.window.Event("error") as any);
    let error: Error | undefined;
    await failed.catch((e) => (error = e));
    expect(error?.message).to.include("failed to load");
    expect(scripts(), "the failed tag is removed").to.have.length(0);

    // A later call starts over rather than returning the cached failure.
    const bundle = { createRecorder: () => ({}) as any, record: (() => undefined) as any };
    const retry = loadReplayBundle("https://self.example/replay.js");
    await tick();
    expect(scripts()).to.have.length(1);
    (jsdom.window as any).FormoReplay = bundle;
    scripts()[0].onload!(new jsdom.window.Event("load") as any);
    expect(await retry).to.equal(bundle);
  });
});
