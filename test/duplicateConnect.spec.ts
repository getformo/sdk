import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: one wallet connection must produce exactly one connect event.
 *
 * `onConnected` and `onAccountsChanged` both observe the same connection, and
 * which of them saw the address first was decided purely by how many awaits
 * each happened to contain. Removing an analytics RPC from the
 * `accountsChanged` path was enough to flip that race and make both emit.
 */
describe("Duplicate connect on the EIP-1193 path", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  const ADDRESS = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";
  const OTHER = "0x88C0224CEABF6D559d7B622F2918b308285280DE";

  beforeEach(() => {
    sandbox = sinon.createSandbox();
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
    // Deliberately NOT deleting `globalThis` or the event methods: other
    // specs in this suite rely on them existing, and removing them here made
    // 16 unrelated tests fail.
    for (const k of ["window","document","location","navigator",
      "localStorage","sessionStorage","crypto"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  const makeProvider = (accounts: string[] = [ADDRESS]) => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const p: any = {
      chainId: "0x1",
      on: (ev: string, fn: any) => { (handlers[ev] ??= []).push(fn); },
      removeListener: () => undefined,
      request: async ({ method }: any) => {
        if (method === "eth_chainId") return "0x1";
        if (method?.startsWith("eth_accounts") || method === "eth_requestAccounts") return accounts;
        return null;
      },
      emit: (ev: string, ...a: unknown[]) => (handlers[ev] ?? []).forEach((f) => f(...a)),
    };
    return p;
  };

  async function connectAndCount(order: "connectFirst" | "accountsFirst") {
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    if (order === "connectFirst") {
      provider.emit("connect", { chainId: "0x1" });
      provider.emit("accountsChanged", [ADDRESS]);
    } else {
      provider.emit("accountsChanged", [ADDRESS]);
      provider.emit("connect", { chainId: "0x1" });
    }
    await new Promise((r) => setTimeout(r, 50));
    formo.cleanup?.();
    return connect.callCount;
  }

  it("emits exactly one connect when `connect` arrives first", async () => {
    expect(await connectAndCount("connectFirst")).to.equal(1);
  });

  it("emits exactly one connect when `accountsChanged` arrives first", async () => {
    expect(await connectAndCount("accountsFirst")).to.equal(1);
  });

  it("still emits for an account switch after the wallet is known", async () => {
    // `accountsChanged` must keep reporting a NEW wallet, so the fix cannot
    // simply gate both handlers on the connection transition.
    const provider = makeProvider();
    (global as any).window.ethereum = provider;
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const connect = sandbox.stub(formo, "connect").resolves();
    (formo as any).registerAccountsChangedListener(provider);
    (formo as any).registerConnectListener(provider);

    provider.emit("connect", { chainId: "0x1" });
    provider.emit("accountsChanged", [ADDRESS]);
    await new Promise((r) => setTimeout(r, 50));
    const afterConnect = connect.callCount;

    provider.emit("accountsChanged", [OTHER]);
    await new Promise((r) => setTimeout(r, 50));

    expect(afterConnect, "one for the connection").to.equal(1);
    expect(connect.callCount, "and one for the switch").to.equal(2);
    formo.cleanup?.();
  });
});
