import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * Regression: an autocaptured signature or transaction must be tagged with the
 * chain of the provider that actually handled it.
 *
 * `_evmChainId` is maintained by `chainChanged` from whichever provider is
 * active. A visitor with two wallets installed can sign through the inactive
 * one, and reading the cache there attributes the event to the wrong chain.
 */
describe("Chain id resolution for autocaptured requests", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let formo: FormoAnalytics;
  let created: FormoAnalytics[] = [];
  let makeFormo: (options?: Record<string, unknown>) => Promise<FormoAnalytics>;

  const ADDRESS = "0x51377e9b985bb90b7c091b9a7d30c93d4c9c1cef";
  const ACTIVE_CHAIN = 1;
  const OTHER_CHAIN = 8453;

  const providerOnChain = (chainId: number) => ({
    request: sandbox.stub().resolves(`0x${chainId.toString(16)}`),
    on: sandbox.stub(),
    removeListener: sandbox.stub(),
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com",
    });
    for (const [key, value] of [
      ["window", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["globalThis", jsdom.window],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
    ] as const) {
      Object.defineProperty(global, key, {
        value, writable: true, configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid-1234" },
      writable: true, configurable: true,
    });

    initStorageManager("test-write-key");

    // Every instance built by a test, torn down in afterEach. An SDK instance
    // owns queue flush timers and provider listeners; leaking them keeps the
    // mocha process alive long after the assertions finish.
    created = [];
    makeFormo = async (options: Record<string, unknown> = {}) => {
      const instance = await FormoAnalytics.init("test-write-key", {
        wagmi: {
          config: {
            subscribe: sandbox.stub().returns(() => {}),
            state: {
              status: "disconnected",
              connections: new Map(),
              current: undefined,
              chainId: undefined,
            },
            _internal: { store: { subscribe: sandbox.stub().returns(() => {}) } },
          } as any,
          queryClient: {
            getMutationCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
            getQueryCache: () => ({ subscribe: sandbox.stub().returns(() => {}) }),
          } as any,
        },
        ...options,
      });
      // A broadcasted transaction starts a receipt poll that retries on a
      // multi-second timer. These mocks never return a recognisable receipt,
      // so the poll would run to exhaustion and hold the process open for
      // roughly 28 seconds on top of every run. No test here asserts on
      // receipts.
      sandbox.stub(instance as any, "pollTransactionReceipt").resolves(undefined);
      created.push(instance);
      return instance;
    };

    formo = await makeFormo();
  });

  afterEach(() => {
    for (const instance of created) {
      try {
        instance.cleanup();
      } catch {
        /* an instance may already be torn down */
      }
    }
    created = [];
    sandbox.restore();
    for (const key of [
      "window", "document", "location", "globalThis",
      "navigator", "localStorage", "sessionStorage", "crypto",
    ]) {
      delete (global as any)[key];
    }
    if (jsdom) jsdom.window.close();
  });

  /** Feed the per-provider chain cache the way a real `chainChanged` would. */
  const announceChain = (instance: any, provider: any, chainId: number) =>
    instance.onChainChanged(provider, `0x${chainId.toString(16)}`);

  it("uses the signing provider's chain when it is not the active provider", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    const other = providerOnChain(OTHER_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });
    await announceChain(formo, other, OTHER_CHAIN);

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      other
    );

    expect(payload.chainId).to.equal(OTHER_CHAIN);
  });

  it("never issues an RPC on the wallet's transport while signing", async () => {
    // The lookup used to run on the signing provider and be time-boxed with
    // Promise.race. A race cannot cancel the provider's request, so on a
    // serialized transport (WalletConnect's relay socket) an abandoned
    // eth_chainId sits at the head of the wallet's queue and wedges every
    // later RPC the dapp makes. Nothing analytics-only may go on that wire.
    const raw = sandbox.stub().callsFake(async ({ method }: any) => {
      if (method === "eth_chainId") throw new Error("must not be called");
      return "0xsigned";
    });
    const signer: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: raw,
    };
    // Wrapping replaces provider.request, so assert against the raw stub.
    (formo as any).registerRequestListeners(signer);
    await signer.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));

    const methods = raw.getCalls().map((c: any) => c.args[0].method);
    expect(methods).to.not.include("eth_chainId");
  });

  it("never issues an RPC on the wallet's transport while sending a transaction", async () => {
    const raw = sandbox.stub().callsFake(async ({ method }: any) => {
      if (method === "eth_chainId") throw new Error("must not be called");
      return "0xtxhash";
    });
    const signer: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: raw,
    };
    // Wrapping replaces provider.request, so assert against the raw stub.
    (formo as any).registerRequestListeners(signer);
    await signer.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const methods = raw.getCalls().map((c: any) => c.args[0].method);
    expect(methods).to.not.include("eth_chainId");
  });

  it("reports unknown rather than the active chain for a wallet it has never heard from", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    const stranger = providerOnChain(OTHER_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      stranger
    );

    // The cached chain belongs to a different wallet, so it is known-wrong
    // here. 0 is the honest answer.
    expect(payload.chainId).to.equal(0);
  });

  it("reads the active provider's chain from central state", async () => {
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      active
    );

    expect(payload.chainId).to.equal(ACTIVE_CHAIN);
    expect(active.request.called, "no RPC for the active provider").to.be.false;
  });

  it("does not inherit a persisted chain when no provider is active", async () => {
    // loadActiveWallet() restores a persisted chainId with no provider
    // attached; a request arriving before connect must not inherit it.
    (formo as any)._provider = undefined;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });
    const signer = providerOnChain(OTHER_CHAIN);

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      signer
    );

    expect(payload.chainId).to.equal(0);
  });

  it("learns a provider's chain when it announces a connection", async () => {
    const signer: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves([ADDRESS]),
    };
    await (formo as any).onConnected(signer, {
      chainId: `0x${OTHER_CHAIN.toString(16)}`,
    });

    const payload = await (formo as any).buildTransactionEventPayload(
      [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      signer
    );
    expect(payload.chainId).to.equal(OTHER_CHAIN);
  });

  it("reuses one chain snapshot across a transaction's statuses", async () => {
    const drifting: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xtxhash"),
    };
    await announceChain(formo, drifting, ACTIVE_CHAIN);

    const seen: number[] = [];
    sandbox.stub(formo, "transaction").callsFake((async (pl: any) => {
      seen.push(pl.chainId);
    }) as any);

    (formo as any).registerRequestListeners(drifting);
    const call = drifting.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
    });
    // The wallet switches network while the prompt is open.
    await announceChain(formo, drifting, 137);
    await call;
    await new Promise((r) => setTimeout(r, 20));

    expect(seen.length).to.be.greaterThan(1);
    expect(new Set(seen).size, "one snapshot for the whole call").to.equal(1);
    expect(seen[0]).to.equal(ACTIVE_CHAIN);
  });

  it("tags a rejected signature with the signing provider's chain", async () => {
    const rejection: any = Object.assign(new Error("User rejected"), { code: 4001 });
    const rejecting: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async () => { throw rejection; }),
    };
    await announceChain(formo, rejecting, OTHER_CHAIN);

    const seen: any[] = [];
    sandbox.stub(formo, "signature").callsFake((async (pl: any) => { seen.push(pl); }) as any);

    (formo as any).registerRequestListeners(rejecting);
    // Asserted precisely: a bare try/catch also passes if the wrapper
    // swallows the rejection and resolves, which would make the dapp treat a
    // declined signature as a successful one.
    let caught: any;
    let resolved = false;
    try {
      await rejecting.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
      resolved = true;
    } catch (e) {
      caught = e;
    }
    expect(resolved, "the wrapper must not swallow the rejection").to.be.false;
    expect(caught, "the wallet's own error reaches the caller").to.equal(rejection);
    expect(caught.code).to.equal(4001);
    await new Promise((r) => setTimeout(r, 20));

    const rejected = seen.find((e) => e.status === "rejected");
    expect(rejected, "a rejected signature event").to.exist;
    expect(rejected.chainId).to.equal(OTHER_CHAIN);
  });

  it("tags a rejected transaction with the signing provider's chain", async () => {
    const rejection: any = Object.assign(new Error("User rejected"), { code: 4001 });
    const rejecting: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async () => { throw rejection; }),
    };
    await announceChain(formo, rejecting, OTHER_CHAIN);

    const seen: any[] = [];
    sandbox.stub(formo, "transaction").callsFake((async (pl: any) => { seen.push(pl); }) as any);

    (formo as any).registerRequestListeners(rejecting);
    let caught: any;
    let resolved = false;
    try {
      await rejecting.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      });
      resolved = true;
    } catch (e) {
      caught = e;
    }
    expect(resolved, "the wrapper must not swallow the rejection").to.be.false;
    expect(caught, "the wallet's own error reaches the caller").to.equal(rejection);
    expect(caught.code).to.equal(4001);
    await new Promise((r) => setTimeout(r, 20));

    expect(seen.map((e) => e.status)).to.include("rejected");
    expect(new Set(seen.map((e) => e.chainId)).size).to.equal(1);
    expect(seen[0].chainId).to.equal(OTHER_CHAIN);
  });

  it("does not let a non-active provider overwrite active wallet state", async () => {
    // Provider A is active with a known chain but no address yet. A signature
    // through B must not write B's address and chain into central state, or
    // every later request through A is attributed to B's chain.
    const active = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = active;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN });
    const other = providerOnChain(OTHER_CHAIN);
    // Seeded directly rather than through onChainChanged: a `chainChanged`
    // from a different provider is a deliberate wallet switch and moves the
    // active provider. Here the point is a *non-active* provider signing.
    (formo as any).rememberProviderChain(other, OTHER_CHAIN);

    const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
    await (formo as any).buildTransactionEventPayload(
      [{ from: OTHER_ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      other
    );

    expect((formo as any)._evmChainId, "active chain untouched").to.equal(ACTIVE_CHAIN);
    expect((formo as any)._evmAddress, "active address untouched").to.be.undefined;
  });

  it("seeds the chain from the provider's own state when tracking starts", async () => {
    // Covers the wiring, not just the helper. Note this goes through
    // trackEIP1193Provider, so it would catch any RPC reintroduced there.
    const tracker = await makeFormo({ tracking: true });
    const rawRequest = sandbox.stub().rejects(new Error("no RPC may be issued"));
    const provider: any = {
      chainId: `0x${OTHER_CHAIN.toString(16)}`,
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: rawRequest,
    };
    // Wagmi mode short-circuits provider tracking, so turn it off for this.
    (tracker as any).isWagmiMode = false;

    (tracker as any).trackEIP1193Provider(provider);
    await new Promise((r) => setTimeout(r, 20));

    expect((tracker as any).resolveChainIdForProvider(provider)).to.equal(OTHER_CHAIN);
    const methods = rawRequest.getCalls().map((c: any) => c.args[0]?.method);
    expect(methods, "no eth_chainId at tracking time").to.not.include("eth_chainId");
  });

  it("issues no RPC at all when tracking a provider that exposes no chain", async () => {
    // The probe this replaces sat on the wallet's single queue, so a stalled
    // one blocked every later signature and transaction the dapp made. Better
    // to report the chain as unknown.
    const tracker = await makeFormo({ tracking: true });
    const rawRequest = sandbox.stub().rejects(new Error("no RPC may be issued"));
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: rawRequest,
    };
    (tracker as any).isWagmiMode = false;

    (tracker as any).trackEIP1193Provider(provider);
    await new Promise((r) => setTimeout(r, 20));

    expect(rawRequest.called, "no RPC issued").to.be.false;
    expect((tracker as any).resolveChainIdForProvider(provider)).to.equal(0);
  });

  it("issues no RPC from the connect observer when connect autocapture is off", async () => {
    // The full connect handler resolves the account with `eth_accounts`.
    // Registering it purely to observe the chain would put an analytics-only
    // request back on the wallet's single queue - the exact hazard the
    // request-path work removed.
    const tracker = await makeFormo({
      tracking: true,
      autocapture: { connect: false, signature: true },
    });
    const rawRequest = sandbox.stub().rejects(new Error("no RPC may be issued"));
    const listeners: Record<string, (...a: unknown[]) => void> = {};
    const provider: any = {
      on: sandbox.stub().callsFake((ev: string, fn: any) => { listeners[ev] = fn; }),
      removeListener: sandbox.stub(),
      request: rawRequest,
    };
    (tracker as any).isWagmiMode = false;
    (tracker as any).trackEIP1193Provider(provider);

    listeners["connect"]?.({ chainId: `0x${OTHER_CHAIN.toString(16)}` });
    await new Promise((r) => setTimeout(r, 20));

    expect(rawRequest.called, "no RPC issued").to.be.false;
    expect((tracker as any).resolveChainIdForProvider(provider)).to.equal(OTHER_CHAIN);
  });

  it("does not let an inactive wallet's chain change seize the active slot", async () => {
    // chainChanged is now observed unconditionally so signatures can be
    // labelled. handleProviderMismatch treats another wallet's chain event as
    // a wallet switch and clears the active wallet - that must not start
    // happening for apps that never asked for chain tracking.
    const tracker = await makeFormo({
      tracking: true,
      autocapture: { chain: false, signature: true },
    });
    const active = providerOnChain(ACTIVE_CHAIN);
    (tracker as any)._provider = active;
    (tracker as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const other = providerOnChain(OTHER_CHAIN);
    await (tracker as any).onChainChanged(other, `0x${OTHER_CHAIN.toString(16)}`);

    expect((tracker as any)._provider, "active provider unchanged").to.equal(active);
    expect((tracker as any)._evmAddress, "active address unchanged").to.equal(ADDRESS);
    expect((tracker as any)._evmChainId, "active chain unchanged").to.equal(ACTIVE_CHAIN);
    // But its chain was still learned, which is the point of observing.
    expect((tracker as any).resolveChainIdForProvider(other)).to.equal(OTHER_CHAIN);
  });

  it("remembers the chain learned while a provider was active", async () => {
    // A standards-compliant provider with no synchronous `chainId` property is
    // otherwise known only while active: once another wallet takes over, a
    // signature back through this one reported 0 and, with exclusions set,
    // was dropped.
    const first: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${OTHER_CHAIN.toString(16)}`;
        return [ADDRESS];
      }),
    };
    await (formo as any).onAccountsChanged(first, [ADDRESS]);

    // Another wallet becomes active.
    const second = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = second;

    expect((formo as any).resolveChainIdForProvider(first)).to.equal(OTHER_CHAIN);
  });

  it("learns the chain from an eth_chainId the app was making anyway", async () => {
    // A standards-compliant provider need not expose a synchronous chainId,
    // and if it connected before the SDK initialised its connect event is
    // never replayed. Reading the answer to a call the dapp already sent adds
    // no request of our own.
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(async ({ method }: any) => {
        if (method === "eth_chainId") return `0x${OTHER_CHAIN.toString(16)}`;
        return "0xsigned";
      }),
    };
    (formo as any).registerRequestListeners(provider);
    expect((formo as any).resolveChainIdForProvider(provider)).to.equal(0);

    // The APP asks, for its own reasons.
    const answer = await provider.request({ method: "eth_chainId" });
    expect(answer, "the answer still reaches the caller").to.equal(
      `0x${OTHER_CHAIN.toString(16)}`
    );

    expect((formo as any).resolveChainIdForProvider(provider)).to.equal(OTHER_CHAIN);
  });

  it("does not let a failed lookup discard an earlier valid one", async () => {
    // The generation used to advance when a lookup STARTED, so a second call
    // that went on to fail still invalidated the first one's good answer and
    // left the provider unknown - which, with exclusions configured, drops
    // all of its events.
    const answers: Array<(v: unknown) => void> = [];
    const rejecters: Array<(e: unknown) => void> = [];
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(() =>
        new Promise((res, rej) => { answers.push(res); rejecters.push(rej); })
      ),
    };
    (formo as any).registerRequestListeners(provider);

    const first = provider.request({ method: "eth_chainId" });
    const second = provider.request({ method: "eth_chainId" });

    // The second call fails; the first then answers correctly.
    rejecters[1](new Error("boom"));
    await second.catch(() => undefined);
    answers[0](`0x${OTHER_CHAIN.toString(16)}`);
    await first;

    expect(
      (formo as any).resolveChainIdForProvider(provider),
      "the good answer survives a failed sibling"
    ).to.equal(OTHER_CHAIN);
  });

  it("refuses unscoped events once an unresolvable chain is current", async () => {
    // page / track / identify carry no chain and fall back to currentChainId.
    // If 0 ever became that value they would be sent for a wallet that could
    // be sitting on an excluded chain.
    const gated = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((gated as any).eventManager, "addEvent").resolves();
    (gated as any).setChainState("evm", { chainId: 0, address: ADDRESS });

    await gated.track("thing");
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.called, "unknown current chain fails closed").to.be.false;
  });

  it("corrects a stale restored chain for the same wallet", async () => {
    // A persisted wallet restores chain 1 from a previous session while its
    // provider has since moved to excluded 8453. The signature is gated
    // correctly, but the stale chain used to survive in currentChainId - and
    // the unscoped events that fall back to it went out under an exclusion
    // that should have caught them.
    const gated = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((gated as any).eventManager, "addEvent").resolves();
    // Restored state: same wallet, old chain.
    (gated as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (gated as any).rememberProviderChain(provider, OTHER_CHAIN);
    (gated as any)._provider = provider;
    (gated as any).registerRequestListeners(provider);

    await provider.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called, "the signature itself is excluded").to.be.false;

    expect(
      (gated as any)._evmChainId,
      "the stale chain is corrected to the live one"
    ).to.equal(OTHER_CHAIN);

    await gated.track("thing");
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called, "so the track that follows is excluded too").to.be.false;
  });

  it("never overwrites a different wallet's chain", async () => {
    const other = await makeFormo({ tracking: true });
    const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
    (other as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    (other as any).backfillActiveWallet(OTHER_ADDRESS, OTHER_CHAIN);

    expect(((other as any)._evmAddress as string)?.toLowerCase()).to.equal(ADDRESS.toLowerCase());
    expect((other as any)._evmChainId, "untouched").to.equal(ACTIVE_CHAIN);
  });

  it("keeps an unresolvable chain as 0 so later events still fail closed", async () => {
    // The end-to-end version of the rule: an unknown-chain signature is
    // dropped, and the `track()` that follows must be dropped too. Erasing 0
    // to undefined here would leave the wallet persisted with no marker, and
    // that track() would go out attributed to a wallet that may well be on an
    // excluded chain.
    const gated = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((gated as any).eventManager, "addEvent").resolves();

    const stranger: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (gated as any).registerRequestListeners(stranger);
    await stranger.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called, "the signature itself is dropped").to.be.false;

    await gated.track("thing");
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called, "and so is the track that follows").to.be.false;

    expect(
      (gated as any)._evmChainId,
      "the unknown marker is retained, not erased"
    ).to.equal(0);
  });

  it("keeps each provider's chain generation separate", async () => {
    // A global counter meant any activity on wallet B discarded a valid
    // in-flight answer for wallet A, leaving A at chain 0 - and, since an
    // unresolved chain fails closed, dropping all of A's events whenever
    // excludeChains is set.
    let releaseA: ((v: string) => void) | undefined;
    const a: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(({ method }: any) =>
        method === "eth_chainId"
          ? new Promise((res) => { releaseA = res as any; })
          : Promise.resolve("0xsigned")
      ),
    };
    const b = providerOnChain(OTHER_CHAIN);
    (formo as any).registerRequestListeners(a);

    const pendingA = a.request({ method: "eth_chainId" });
    // Unrelated activity on B while A's lookup is still in flight.
    (formo as any).rememberProviderChain(b, OTHER_CHAIN);
    releaseA!(`0x${ACTIVE_CHAIN.toString(16)}`);
    await pendingA;

    expect(
      (formo as any).resolveChainIdForProvider(a),
      "A's own answer survives B's activity"
    ).to.equal(ACTIVE_CHAIN);
    expect((formo as any).resolveChainIdForProvider(b)).to.equal(OTHER_CHAIN);
  });

  it("does not let a slow accountsChanged lookup undo a newer chainChanged", async () => {
    // onAccountsChanged resolves the chain itself. Writing that answer back
    // unconditionally undid a `chainChanged` that landed while it was in
    // flight, relabelling later activity onto a chain the wallet had left.
    let releaseLookup: ((v: string) => void) | undefined;
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(({ method }: any) => {
        if (method === "eth_chainId") {
          return new Promise((res) => { releaseLookup = res as any; });
        }
        return Promise.resolve([ADDRESS]);
      }),
    };

    const pending = (formo as any).onAccountsChanged(provider, [ADDRESS]);
    // The wallet switches chain while that lookup is outstanding.
    (formo as any).rememberProviderChain(provider, OTHER_CHAIN);
    releaseLookup!(`0x${ACTIVE_CHAIN.toString(16)}`);
    await pending;

    expect(
      (formo as any).resolveChainIdForProvider(provider),
      "the newer chainChanged wins"
    ).to.equal(OTHER_CHAIN);
  });

  it("does not let a slow eth_chainId answer overwrite a newer chainChanged", async () => {
    let releaseChainId: ((v: string) => void) | undefined;
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().callsFake(({ method }: any) => {
        if (method === "eth_chainId") {
          return new Promise((resolve) => { releaseChainId = resolve as any; });
        }
        return Promise.resolve("0xsigned");
      }),
    };
    (formo as any).registerRequestListeners(provider);

    const pending = provider.request({ method: "eth_chainId" });
    // A chainChanged lands first; it is newer by definition.
    (formo as any).rememberProviderChain(provider, OTHER_CHAIN);
    // The stale answer now arrives naming the chain the wallet already left.
    releaseChainId!(`0x${ACTIVE_CHAIN.toString(16)}`);
    await pending;

    expect((formo as any).resolveChainIdForProvider(provider)).to.equal(OTHER_CHAIN);
  });

  it("observes chain changes even when chain autocapture is off", async () => {
    // Observing a chain and reporting one are different concerns. Gating the
    // listener on autocapture.chain froze the chain at whatever was first
    // seen, so a switch to an excluded chain went unnoticed and its
    // signatures were emitted under the old, allowed chain.
    const tracker = await makeFormo({
      tracking: true,
      autocapture: { chain: false, signature: true },
    });
    const provider: any = {
      chainId: `0x${ACTIVE_CHAIN.toString(16)}`,
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (tracker as any).isWagmiMode = false;
    (tracker as any).trackEIP1193Provider(provider);
    await new Promise((r) => setTimeout(r, 20));
    expect((tracker as any).resolveChainIdForProvider(provider)).to.equal(ACTIVE_CHAIN);

    // A chainChanged listener must have been registered despite chain: false.
    const registered = provider.on
      .getCalls()
      .map((c: any) => c.args[0]);
    expect(registered, "chainChanged observed").to.include("chainChanged");

    await (tracker as any).onChainChanged(
      provider,
      `0x${OTHER_CHAIN.toString(16)}`
    );
    expect((tracker as any).resolveChainIdForProvider(provider)).to.equal(OTHER_CHAIN);
  });



  it("reports the active chain when asked without a provider", async () => {
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });
    expect((formo as any).resolveChainIdForProvider(undefined)).to.equal(ACTIVE_CHAIN);
  });


  it("exposes whether an event carrying a chain would be sent", async () => {
    // Integrations that keep their own "already reported" state need this:
    // syncWalletState can accept a wallet whose event trackEvent then drops.
    const gated = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    expect(gated.willTrackEvent(ACTIVE_CHAIN), "allowed chain").to.be.true;
    expect(gated.willTrackEvent(OTHER_CHAIN), "excluded chain").to.be.false;

    const off = await makeFormo({ tracking: false });
    expect(off.willTrackEvent(ACTIVE_CHAIN), "tracking disabled").to.be.false;
  });

  it("refuses a chain-scoped event whose chain is unknown when exclusions are set", async () => {
    // 0 is in no exclusion list, so treating "unknown" as "allowed" would let
    // through exactly the events an operator excluded.
    const excluded = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((excluded as any).eventManager, "addEvent").resolves();

    const stranger: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (excluded as any).registerRequestListeners(stranger);
    await stranger.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.called, "unknown chain must fail closed").to.be.false;
  });

  it("excludes an event on the signing provider's chain, not the active one", async () => {
    // The whole point of resolving the signer's chain is lost if the exclusion
    // gate still reads the active provider's. Active chain 1 is allowed, the
    // secondary signer is on excluded 8453, so nothing may be emitted.
    const excluded = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((excluded as any).eventManager, "addEvent").resolves();

    const active = providerOnChain(ACTIVE_CHAIN);
    (excluded as any)._provider = active;
    (excluded as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const other: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    // Seeded directly, NOT via onChainChanged: that method treats a chain
    // event from a different provider as a wallet switch, makes it active and
    // clears central state, so the secondary chain would become the central
    // one and the test would pass even against the old central-chain gate.
    (excluded as any).rememberProviderChain(other, OTHER_CHAIN);
    (excluded as any).registerRequestListeners(other);
    await other.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));

    expect(
      (excluded as any)._provider,
      "the active provider must still be the active one"
    ).to.equal(active);
    expect(
      (excluded as any)._evmChainId,
      "central chain must still be the active provider's"
    ).to.equal(ACTIVE_CHAIN);
    expect(addEvent.called, "excluded chain must not be tracked").to.be.false;
  });

  it("still emits when the active chain is excluded but the signer's is not", async () => {
    // The inverse. Reading the central field would drop a perfectly allowed
    // event because the *other* wallet happens to sit on an excluded chain.
    const excluded = await makeFormo({ tracking: { excludeChains: [ACTIVE_CHAIN] } });
    const addEvent = sandbox.stub((excluded as any).eventManager, "addEvent").resolves();

    const active = providerOnChain(ACTIVE_CHAIN);
    (excluded as any)._provider = active;
    (excluded as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    const other: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (excluded as any).rememberProviderChain(other, OTHER_CHAIN);
    (excluded as any).registerRequestListeners(other);
    await other.request({ method: "personal_sign", params: ["0x68690000", ADDRESS] });
    await new Promise((r) => setTimeout(r, 20));

    expect(
      (excluded as any)._evmChainId,
      "central chain must still be the excluded active one"
    ).to.equal(ACTIVE_CHAIN);
    expect(addEvent.called, "allowed chain must still be tracked").to.be.true;
  });




  it("passes requests straight through when autocapture is off", async () => {
    const off = await makeFormo({
      tracking: true,
      autocapture: { signature: false, transaction: false },
    });
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xok"),
    };
    (off as any).registerRequestListeners(provider);

    expect(await provider.request({ method: "personal_sign", params: ["0x68", ADDRESS] })).to.equal("0xok");
    expect(
      await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: "0xabc", value: "0x0", data: "0x" }],
      })
    ).to.equal("0xok");
  });

  it("rejects payloads whose address is not a valid EIP-55 address", async () => {
    const bad = "0xnot-an-address";
    expect(() =>
      (formo as any).buildSignatureEventPayload("personal_sign", ["0x68", bad])
    ).to.throw(/Invalid address in signature payload/);
    await (formo as any)
      .buildTransactionEventPayload([{ from: bad, to: "0xabc", value: "0x0", data: "0x" }])
      .then(
        () => expect.fail("should have thrown"),
        (e: Error) => expect(e.message).to.match(/Invalid address in transaction payload/)
      );
  });

  it("skips wrapping a provider whose request cannot be replaced", async () => {
    const frozen: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
    };
    Object.defineProperty(frozen, "request", {
      value: async () => "0xok",
      writable: false,
      configurable: false,
    });
    // Must not throw out of provider tracking.
    expect(() => (formo as any).registerRequestListeners(frozen)).to.not.throw();
  });

  it("survives a chain event that fails to emit", async () => {
    const provider = providerOnChain(ACTIVE_CHAIN);
    (formo as any)._provider = provider;
    (formo as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });
    sandbox.stub(formo, "chain").rejects(new Error("queue is gone"));

    // Must not reject out of the listener; the error is logged and swallowed.
    await (formo as any).onChainChanged(
      provider,
      `0x${OTHER_CHAIN.toString(16)}`
    );
    expect(
      (formo as any).resolveChainIdForProvider(provider),
      "and the chain is still recorded"
    ).to.equal(OTHER_CHAIN);
  });

  it("does not wrap the same provider twice", async () => {
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xok"),
    };
    (formo as any).registerRequestListeners(provider);
    const wrappedOnce = provider.request;
    (formo as any).registerRequestListeners(provider);

    expect(provider.request, "left alone the second time").to.equal(wrappedOnce);
  });

  it("contains a failure while building the signature event", async () => {
    // The fire-and-forget REQUESTED block must never reject out of the
    // wrapper - the wallet call has to proceed regardless.
    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (formo as any).rememberProviderChain(provider, ACTIVE_CHAIN);
    sandbox.stub(formo, "signature").rejects(new Error("queue is gone"));
    (formo as any).registerRequestListeners(provider);

    const result = await provider.request({
      method: "personal_sign",
      params: ["0x68690000", ADDRESS],
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(result, "the signature still reaches the caller").to.equal("0xsigned");
  });

  it("does not restore a stale chain when a request completes", async () => {
    // A request captures its chain once and reuses it for every status, which
    // is right for the payload. Writing that captured value back into central
    // state on the later statuses restored a chain the wallet had left.
    const gated = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((gated as any).eventManager, "addEvent").resolves();

    const provider: any = {
      on: sandbox.stub(),
      removeListener: sandbox.stub(),
      request: sandbox.stub().resolves("0xsigned"),
    };
    (gated as any)._provider = provider;
    (gated as any).rememberProviderChain(provider, ACTIVE_CHAIN);
    (gated as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });
    (gated as any).registerRequestListeners(provider);

    // The wallet moves to the excluded chain while the prompt is open.
    const pending = provider.request({
      method: "personal_sign",
      params: ["0x68690000", ADDRESS],
    });
    (gated as any).rememberProviderChain(provider, OTHER_CHAIN);
    await pending;
    await new Promise((r) => setTimeout(r, 20));

    expect(
      (gated as any)._evmChainId,
      "central state follows the wallet, not the captured snapshot"
    ).to.equal(OTHER_CHAIN);

    addEvent.resetHistory();
    await gated.track("thing");
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called, "so the exclusion still applies").to.be.false;
  });

  it("syncs central state when the active provider reports a new chain", async () => {
    // Recording an observation only per provider left `currentChainId` on a
    // chain restored from a previous session.
    const gated = await makeFormo({ tracking: { excludeChains: [OTHER_CHAIN] } });
    const addEvent = sandbox.stub((gated as any).eventManager, "addEvent").resolves();
    const provider = providerOnChain(ACTIVE_CHAIN);
    (gated as any)._provider = provider;
    (gated as any).setChainState("evm", { chainId: ACTIVE_CHAIN, address: ADDRESS });

    // The app asks; the wallet is really on the excluded chain.
    (gated as any).rememberProviderChain(provider, OTHER_CHAIN);

    expect((gated as any)._evmChainId, "central state follows").to.equal(OTHER_CHAIN);

    await gated.track("thing");
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called, "and the exclusion applies").to.be.false;
  });
});
