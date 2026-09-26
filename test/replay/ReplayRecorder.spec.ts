import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { initStorageManager, session } from "../../src/storage";
import * as fetchModule from "../../src/fetch";
import { ReplayRecorder } from "../../src/replay/ReplayRecorder";
import {
  RecordFn,
  ReplayEmit,
  ReplayEvent,
  ReplayRecorderDeps,
} from "../../src/replay/types";
import { generateNativeUUID } from "../../src/utils/generate";
import { clearReplaySession } from "../../src/replay/session";
import {
  REPLAY_FLUSH_INTERVAL_MS,
  REPLAY_IDLE_PAUSE_MS,
  REPLAY_IDLE_TIMEOUT_MS,
} from "../../src/replay/constants";

const META = (href = "https://example.com/"): ReplayEvent => ({
  type: 4,
  data: { href, width: 1024, height: 768 },
  timestamp: Date.now(),
});
const FULL = (): ReplayEvent => ({ type: 2, data: { node: {} }, timestamp: Date.now() });
const CLICK = (): ReplayEvent => ({
  type: 3,
  data: { source: 2, type: 2, id: 1, x: 1, y: 1 },
  timestamp: Date.now(),
});
const MUTATION = (): ReplayEvent => ({
  type: 3,
  data: { source: 0, adds: [], removes: [], texts: [], attributes: [] },
  timestamp: Date.now(),
});

/** A stand-in for rrweb's record(): emits Meta + FullSnapshot on start. */
function fakeRecord() {
  let emit: ReplayEmit | undefined;
  const stop = sinon.spy();
  const record = sinon.spy((options: { emit: ReplayEmit }) => {
    emit = options.emit;
    emit(META());
    emit(FULL());
    return stop;
  }) as unknown as RecordFn & sinon.SinonSpy;
  record.takeFullSnapshot = sinon.spy(() => {
    emit?.(META());
    emit?.(FULL());
  });
  return {
    record,
    stop,
    emit: (event: ReplayEvent) => emit?.(event),
  };
}

async function decode(properties: any): Promise<ReplayEvent[]> {
  if (properties.encoding === "json") return JSON.parse(properties.data);
  const bytes = Uint8Array.from(Buffer.from(properties.data, "base64"));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

describe("ReplayRecorder", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let clock: sinon.SinonFakeTimers;
  let fetchStub: sinon.SinonStub;

  const sent = (): any[] =>
    fetchStub.args.flatMap((call: any) => JSON.parse(call[1].body));

  function makeDeps(overrides: Partial<ReplayRecorderDeps> = {}): ReplayRecorderDeps {
    return {
      writeKey: "test-write-key",
      apiHost: "https://events.example/v0/raw_events",
      options: {},
      storage: session(),
      generateId: generateNativeUUID,
      logger: { info() {}, warn() {}, error() {} },
      canSend: () => true,
      canRecord: () => true,
      createEnvelope: async (properties) =>
        ({
          type: "replay",
          channel: "web",
          version: "0",
          anonymous_id: "anon-1",
          user_id: null,
          address: null,
          original_timestamp: new Date().toISOString(),
          context: { page_url: "https://example.com/" },
          properties,
        }) as any,
      redactUrl: (href) => href.replace(/\?.*$/, ""),
      ...overrides,
    };
  }

  /** Let the send chain settle: encode, envelope, fetch. */
  async function settle(recorder: ReplayRecorder) {
    await (recorder as any).sending;
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
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    initStorageManager("test-write-key");
    // The storage manager is a process-wide singleton bound to the first
    // spec's jsdom, so clear through it rather than this jsdom's storage.
    clearReplaySession(session());
    clock = sinon.useFakeTimers({
      now: new Date("2026-09-24T10:00:00Z"),
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    fetchStub = sandbox.stub(fetchModule, "default").resolves({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
  });

  afterEach(() => {
    clock.restore();
    sandbox.restore();
    for (const k of ["window", "document", "location", "navigator", "localStorage", "sessionStorage"]) {
      delete (global as any)[k];
    }
    jsdom.window.close();
  });

  it("sends the first chunk with a full snapshot in the contract shape", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    expect(recorder.replayId).to.be.a("string");

    fake.emit(CLICK());
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);

    expect(fetchStub.calledOnce).to.equal(true);
    const [url, init] = fetchStub.firstCall.args;
    expect(url).to.equal("https://events.example/v0/raw_events");
    expect(init.headers.Authorization).to.equal("Bearer test-write-key");

    const [chunk] = sent();
    expect(chunk.type).to.equal("replay");
    expect(chunk.message_id).to.be.a("string");
    expect(chunk.sent_at).to.be.a("string");
    expect(chunk.properties).to.include({
      replay_id: recorder.replayId,
      chunk_index: 0,
      event_count: 3,
      has_full_snapshot: true,
      click_count: 1,
      keypress_count: 0,
      encoding: "gzip-base64",
    });
    const events = await decode(chunk.properties);
    expect(events.map((e) => e.type)).to.deep.equal([4, 2, 3]);
    recorder.stop(true);
  });

  it("sends a full snapshot at once, gzipped, without waiting for the interval", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    clock.tick(0);
    await settle(recorder);

    const [chunk] = sent();
    expect(chunk.properties.has_full_snapshot).to.equal(true);
    expect(chunk.properties.encoding).to.equal("gzip-base64");
    recorder.stop(true);
  });

  it("passes privacy defaults and custom selectors to rrweb", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(
      makeDeps({ options: { record: fake.record, maskTextSelector: ".secret" } })
    );
    await recorder.start();
    const options = (fake.record as any).firstCall.args[0];
    expect(options.maskAllInputs).to.equal(true);
    expect(options.maskTextSelector).to.equal("[data-formo-mask], .secret");
    expect(options.blockSelector).to.equal("[data-formo-block]");
    expect(options.recordCanvas).to.equal(false);
    recorder.stop(true);
  });

  it("redacts the recorded page URL", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    fake.emit(META("https://example.com/cb?privy_oauth_code=secret"));
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);
    const events = await decode(sent()[0].properties);
    expect(JSON.stringify(events)).to.not.include("secret");
    recorder.stop(true);
  });

  it("does not record a tab outside the sample", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(
      makeDeps({ options: { record: fake.record, sampleRate: 0 } })
    );
    await recorder.start();
    expect((fake.record as any).called).to.equal(false);
    expect(recorder.replayId).to.equal(undefined);
  });

  it("does not record when tracking is suppressed", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(
      makeDeps({ options: { record: fake.record }, canRecord: () => false })
    );
    await recorder.start();
    expect((fake.record as any).called).to.equal(false);
  });

  it("drops the buffer instead of sending once consent is withdrawn", async () => {
    let consent = true;
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(
      makeDeps({ options: { record: fake.record }, canSend: () => consent })
    );
    await recorder.start();
    consent = false;
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);
    expect(fetchStub.called).to.equal(false);
    recorder.stop(true);
  });

  it("stop(true) discards and stops rrweb", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    recorder.stop(true);
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);
    expect(fake.stop.calledOnce).to.equal(true);
    expect(fetchStub.called).to.equal(false);
    expect(recorder.replayId).to.equal(undefined);
  });

  it("sends the buffer synchronously on page leave, as JSON with keepalive", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    await Promise.resolve(); // the envelope template is built on start
    fake.emit(CLICK());
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));

    expect(fetchStub.calledOnce).to.equal(true);
    expect(fetchStub.firstCall.args[1].keepalive).to.equal(true);
    const [chunk] = sent();
    expect(chunk.properties.encoding).to.equal("json");
    expect(chunk.properties.chunk_index).to.equal(0);
    recorder.stop(true);
  });

  it("continues the same replay and chunk sequence after a reload", async () => {
    const first = fakeRecord();
    const before = new ReplayRecorder(makeDeps({ options: { record: first.record } }));
    await before.start();
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(before);
    const replayId = before.replayId;
    before.stop(true);

    const second = fakeRecord();
    const after = new ReplayRecorder(makeDeps({ options: { record: second.record } }));
    await after.start();
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(after);

    expect(after.replayId).to.equal(replayId);
    expect(sent().map((c) => c.properties.chunk_index)).to.deep.equal([0, 1]);
    after.stop(true);
  });

  it("starts a new replay after the idle timeout", async () => {
    const first = fakeRecord();
    const before = new ReplayRecorder(makeDeps({ options: { record: first.record } }));
    await before.start();
    const replayId = before.replayId;
    before.stop(true);

    clock.tick(REPLAY_IDLE_TIMEOUT_MS + 1);
    const second = fakeRecord();
    const after = new ReplayRecorder(makeDeps({ options: { record: second.record } }));
    await after.start();
    expect(after.replayId).to.be.a("string").and.not.equal(replayId);
    after.stop(true);
  });

  it("pauses DOM changes when idle, and takes a snapshot on the next input", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);
    fetchStub.resetHistory();

    clock.tick(REPLAY_IDLE_PAUSE_MS + 1);
    fake.emit(MUTATION());
    fake.emit(MUTATION());
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);
    expect(fetchStub.called).to.equal(false);

    fake.emit(CLICK());
    expect((fake.record.takeFullSnapshot as sinon.SinonSpy).calledOnce).to.equal(true);
    clock.tick(REPLAY_FLUSH_INTERVAL_MS);
    await settle(recorder);
    const events = await decode(sent()[0].properties);
    expect(events.map((e) => e.type)).to.deep.equal([4, 2, 3]);
    recorder.stop(true);
  });

  it("reset() starts a new replay for the next identity", async () => {
    const fake = fakeRecord();
    const recorder = new ReplayRecorder(makeDeps({ options: { record: fake.record } }));
    await recorder.start();
    const replayId = recorder.replayId;
    recorder.reset();
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.replayId).to.be.a("string").and.not.equal(replayId);
    recorder.stop(true);
  });
});
