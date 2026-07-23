import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { EventFactory } from "../../../src/event/EventFactory";
import { initStorageManager } from "../../../src/storage";

/**
 * EventFactory.create user_id resolution.
 *
 * An identify event asserts an explicit identity in its own payload (e.g. a
 * Privy DID for each wallet being clustered). It must keep that payload user_id
 * rather than being overwritten by the active-session user id passed in — that
 * overwrite would strip the DID from every clustering identify emitted with
 * setActive:false and break server-side wallet clustering.
 */
describe("EventFactory.create user_id resolution", () => {
  let jsdom: JSDOM;
  let eventFactory: EventFactory;

  const ADDRESS = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
  const DID = "did:privy:abc123";

  beforeEach(() => {
    jsdom = new JSDOM(
      "<!DOCTYPE html><html><head></head><body></body></html>",
      { url: "https://formo.so/" }
    );
    Object.defineProperty(global, "window", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "document", {
      value: jsdom.window.document, writable: true, configurable: true,
    });
    Object.defineProperty(global, "location", {
      value: jsdom.window.location, writable: true, configurable: true,
    });
    Object.defineProperty(global, "globalThis", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "navigator", {
      value: jsdom.window.navigator, writable: true, configurable: true,
    });
    Object.defineProperty(global, "screen", {
      value: jsdom.window.screen, writable: true, configurable: true,
    });
    Object.defineProperty(global, "Intl", {
      value: {
        DateTimeFormat: () => ({
          resolvedOptions: () => ({ timeZone: "America/New_York" }),
        }),
      },
      writable: true, configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: jsdom.window.localStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "sessionStorage", {
      value: jsdom.window.sessionStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
      writable: true, configurable: true,
    });

    initStorageManager("test-write-key");
    eventFactory = new EventFactory();
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).location;
    delete (global as any).globalThis;
    delete (global as any).navigator;
    delete (global as any).screen;
    delete (global as any).Intl;
    delete (global as any).localStorage;
    delete (global as any).sessionStorage;
    delete (global as any).crypto;
    if (jsdom) jsdom.window.close();
  });

  it("keeps the identify payload user_id (DID) over the active-session user id", async () => {
    // A clustering identify (setActive:false) passes the DID in the payload but
    // the active-session user id is unchanged (here: undefined).
    const result = await eventFactory.create(
      { type: "identify", address: ADDRESS, userId: DID } as any,
      ADDRESS,
      undefined
    );
    expect(result.user_id).to.equal(DID);
  });

  it("keeps the payload DID even when the active-session user id is a different value", async () => {
    const result = await eventFactory.create(
      { type: "identify", address: ADDRESS, userId: DID } as any,
      ADDRESS,
      "some-other-user"
    );
    expect(result.user_id).to.equal(DID);
  });

  it("falls back to the active-session user id when the identify payload has none", async () => {
    const result = await eventFactory.create(
      { type: "identify", address: ADDRESS } as any,
      ADDRESS,
      "session-user"
    );
    expect(result.user_id).to.equal("session-user");
  });

  it("uses the active-session user id for non-identify events", async () => {
    const result = await eventFactory.create(
      { type: "track", event: "custom" } as any,
      ADDRESS,
      "session-user"
    );
    expect(result.user_id).to.equal("session-user");
  });
});
