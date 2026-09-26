import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager, session } from "../../src/storage";
import * as fetchModule from "../../src/fetch";
import { clearReplaySession } from "../../src/replay/session";
import { RecordFn, ReplayEmit } from "../../src/replay/types";
import { replay } from "../../src/replay";

/** SDK-level wiring: options, identity on chunks, event links, consent. */
describe("Session replay through FormoAnalytics", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let fetchStub: sinon.SinonStub;

  const sent = (): any[] =>
    fetchStub.args.flatMap((call: any) => {
      try {
        return JSON.parse(call?.[1]?.body ?? "[]");
      } catch {
        return [];
      }
    });

  function fakeRecord() {
    let emit: ReplayEmit | undefined;
    const stop = sinon.spy();
    const record = sinon.spy((options: { emit: ReplayEmit }) => {
      emit = options.emit;
      emit({ type: 4, data: { href: location.href }, timestamp: Date.now() });
      emit({ type: 2, data: { node: {} }, timestamp: Date.now() });
      return stop;
    }) as unknown as RecordFn & sinon.SinonSpy;
    return { record, stop, emit: (e: any) => emit?.(e) };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com/",
    });
    for (const [k, v] of [
      ["window", jsdom.window],
      // Other specs delete these globals; set them as they do.
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
        writable: true,
        configurable: true,
      });
    }
    initStorageManager("test-write-key");
    clearReplaySession(session());
    fetchStub = sandbox.stub(fetchModule, "default").resolves({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    } as Response);
  });

  afterEach(() => {
    sandbox.restore();
    for (const k of ["window", "document", "location", "navigator", "localStorage", "sessionStorage"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  it("is off unless configured", async () => {
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    expect((formo as any).replay).to.equal(undefined);
  });

  it("sends chunks with the SDK identity, and links events to the replay", async () => {
    const fake = fakeRecord();
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      apiHost: "https://proxy.example/ingest",
      replay: replay({ record: fake.record }),
    });
    const replayId = (formo as any).replay.replayId;
    expect(replayId).to.be.a("string");

    await formo.track("custom-event");
    await (formo as any).eventManager.eventQueue.flush();
    (formo as any).replay.flush();
    await (formo as any).replay.sending;

    const track = sent().find((e) => e.type === "track");
    expect(track.context.replay_id).to.equal(replayId);

    const chunk = sent().find((e) => e.type === "replay");
    expect(chunk.anonymous_id).to.equal(track.anonymous_id);
    expect(chunk.properties.replay_id).to.equal(replayId);
    expect(chunk.context.page_url).to.equal("https://example.com/");
    const replayCall = fetchStub.args.find((call) => call[1].body.includes('"replay"'));
    expect(replayCall![0]).to.equal("https://proxy.example/ingest");
  });

  it("stops recording and sends nothing after opt-out", async () => {
    const fake = fakeRecord();
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      replay: replay({ record: fake.record }),
    });
    formo.optOutTracking();
    expect(fake.stop.calledOnce).to.equal(true);
    expect((formo as any).replay.replayId).to.equal(undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent().filter((e) => e.type === "replay")).to.deep.equal([]);
    formo.optInTracking();
  });

  it("stops rrweb on cleanup()", async () => {
    const fake = fakeRecord();
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      replay: replay({ record: fake.record }),
    });
    formo.cleanup();
    expect(fake.stop.calledOnce).to.equal(true);
  });
});
