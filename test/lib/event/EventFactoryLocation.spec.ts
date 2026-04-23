import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { EventFactory } from "../../../src/event/EventFactory";
import { initStorageManager } from "../../../src/storage";

const TIMEZONE = { value: "UTC" };

function stubIntl(timeZone: string | undefined) {
  TIMEZONE.value = timeZone ?? "";
  Object.defineProperty(global, "Intl", {
    value: {
      DateTimeFormat: () => ({
        resolvedOptions: () => ({ timeZone: TIMEZONE.value }),
      }),
    },
    writable: true,
    configurable: true,
  });
}

async function resolveLocation(factory: EventFactory): Promise<string> {
  const event = await factory.generatePageEvent(undefined, undefined, {}, {});
  return (event.context as any).location as string;
}

describe("EventFactory.getLocation", () => {
  let jsdom: JSDOM;
  let factory: EventFactory;

  beforeEach(() => {
    jsdom = new JSDOM(
      "<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>",
      { url: "https://example.com/test" }
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
    Object.defineProperty(global, "localStorage", {
      value: jsdom.window.localStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "sessionStorage", {
      value: jsdom.window.sessionStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "00000000-0000-0000-0000-000000000000" },
      writable: true, configurable: true,
    });

    initStorageManager("test-write-key");
    factory = new EventFactory();
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

  it("returns '' when Intl reports UTC", async () => {
    stubIntl("UTC");
    expect(await resolveLocation(factory)).to.equal("");
  });

  it("returns '' when Intl reports an Etc/GMT offset zone", async () => {
    stubIntl("Etc/GMT+5");
    expect(await resolveLocation(factory)).to.equal("");
  });

  it("returns 'UA' for Europe/Kyiv", async () => {
    stubIntl("Europe/Kyiv");
    expect(await resolveLocation(factory)).to.equal("UA");
  });

  it("returns 'UA' for legacy Europe/Kiev", async () => {
    stubIntl("Europe/Kiev");
    expect(await resolveLocation(factory)).to.equal("UA");
  });

  it("returns 'MX' for America/Ciudad_Juarez", async () => {
    stubIntl("America/Ciudad_Juarez");
    expect(await resolveLocation(factory)).to.equal("MX");
  });

  it("returns '' for an unknown timezone", async () => {
    stubIntl("Mars/Jezero");
    expect(await resolveLocation(factory)).to.equal("");
  });

  it("returns 'US' for America/Phoenix (no comma-separated leak)", async () => {
    stubIntl("America/Phoenix");
    expect(await resolveLocation(factory)).to.equal("US");
  });

  it("returns 'GU' for Pacific/Guam (no comma-separated leak)", async () => {
    stubIntl("Pacific/Guam");
    expect(await resolveLocation(factory)).to.equal("GU");
  });
});
