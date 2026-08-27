import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { WagmiEventHandler, __resetSeededWallet } from "../../src/wagmi/WagmiEventHandler";
import { WagmiState, QueryClient } from "../../src/wagmi/types";

/**
 * WalletConnect peer naming, wagmi path (P-2403).
 *
 * WalletConnect is a transport; the signing wallet names itself in the
 * session's peer metadata, reachable only through the connector's async
 * getProvider(). Connect emission is deliberately synchronous, so the name
 * is resolved fire-and-forget and cached: the first event may honestly say
 * "WalletConnect", and everything after resolution names the real wallet.
 */
describe("WagmiEventHandler WalletConnect peer naming", () => {
  const ADDRESS = "0x1234567890123456789012345678901234567890";

  let sandbox: sinon.SinonSandbox;
  let mockFormo: any;
  let statusListener: ((s: WagmiState["status"], p: WagmiState["status"]) => void) | null;
  let handler: WagmiEventHandler | undefined;

  const makeConnector = (peerName?: string) => ({
    id: "walletConnect",
    name: "WalletConnect",
    type: "walletConnect",
    uid: "wc-1",
    getProvider: async () =>
      peerName
        ? { session: { peer: { metadata: { name: peerName, url: "https://ledger.com" } } } }
        : {},
  });

  // One state object per session: wagmi keeps the same connection object
  // while a session lives, and replaces it on reconnect. The cache is keyed
  // by that object, so tests must model it faithfully.
  const stateWith = (connector: any): WagmiState => {
    const connections = new Map();
    connections.set("wc-conn", { accounts: [ADDRESS], chainId: 1, connector });
    return { status: "connected", connections, current: "wc-conn", chainId: 1 };
  };

  beforeEach(() => {
    __resetSeededWallet();
    sandbox = sinon.createSandbox();
    statusListener = null;
    mockFormo = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      chain: sandbox.stub().resolves(),
      signature: sandbox.stub().resolves(),
      transaction: sandbox.stub().resolves(),
      isAutocaptureEnabled: sandbox.stub().returns(true),
      syncWalletState: sandbox.stub().callsFake((params: any) => {
        mockFormo.currentAddress = params?.address;
        mockFormo.currentChainId = params?.chainId;
      }),
      willTrackEvent: sandbox.stub().returns(true),
      currentAddress: undefined,
      currentChainId: undefined,
      writeKey: "test-write-key",
    };
  });

  afterEach(() => {
    handler?.cleanup?.();
    sandbox.restore();
  });

  const disconnectedState = (): WagmiState => ({
    status: "disconnected",
    connections: new Map(),
    current: undefined,
    chainId: undefined,
  });

  /**
   * Mount over a DISCONNECTED store, as a real WalletConnect page load is:
   * the session restores asynchronously after the handler exists, and the
   * connect flows through handleStatusChange - the path that awaits the
   * bounded peer lookup. Returns a setState to swap in the connected state
   * before firing the status listener.
   */
  const mount = () => {
    let state: WagmiState = disconnectedState();
    const config: any = {
      subscribe: sandbox.stub().callsFake((selector: any, listener: any) => {
        // Route only the status subscription; the handler's other
        // subscriptions are irrelevant to this spec.
        const probe: WagmiState = {
          status: "probe" as never,
          connections: new Map(),
          current: undefined,
          chainId: undefined,
        };
        if (selector(probe) === "probe") statusListener = listener;
        return () => undefined;
      }),
      getState: () => state,
      get state() {
        return state;
      },
    };
    const queryClient: QueryClient = {
      getMutationCache: () => ({ subscribe: () => () => undefined }),
      getQueryCache: () => ({ subscribe: () => () => undefined }),
    } as any;
    handler = new WagmiEventHandler(mockFormo, config, queryClient);
    return (next: WagmiState) => {
      state = next;
    };
  };

  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("never serves a previous session's name to a new session's connect", async () => {
    // The connect flow reads the cache in the same tick it kicks the
    // lookup, so a retained name would deterministically attribute a
    // reconnect-to-a-different-wallet to the OLD wallet. A new connection
    // clears the cache synchronously: generic is honest, wrong is not.
    // The resolved peer serves the session's LATER reads instead.
    const connector = makeConnector("Ledger Live");
    const setState = mount();
    setState(stateWith(connector));
    await statusListener?.("connected", "disconnected");
    await flush();
    expect(mockFormo.connect.firstCall.args[1]?.providerName).to.equal("WalletConnect");

    handler?.cleanup?.();
    __resetSeededWallet();
    (connector as any).getProvider = async () => ({
      session: { peer: { metadata: { name: "MetaMask Mobile" } } },
    });
    const setState2 = mount();
    setState2(stateWith(connector));
    await statusListener?.("connected", "disconnected");
    await flush();

    // Not "Ledger Live": the old wallet's name must not cross sessions.
    expect(mockFormo.connect.lastCall.args[1]?.providerName).to.equal("WalletConnect");
  });

  it("keeps the connector's own name when the session has no peer", async () => {
    const connector = makeConnector(undefined);
    const setState = mount();
    setState(stateWith(connector));

    await statusListener?.("connected", "disconnected");
    await flush();

    expect(mockFormo.connect.lastCall.args[1]?.providerName).to.equal("WalletConnect");
  });

  it("drops a cached name when the new session cannot be inspected", async () => {
    // A rejecting getProvider means the previous wallet's name is unproven
    // for this session; generic is honest, stale is not.
    const connector = makeConnector("Ledger Live");
    const setState = mount();
    setState(stateWith(connector));
    await statusListener?.("connected", "disconnected");
    await flush();

    handler?.cleanup?.();
    __resetSeededWallet();
    (connector as any).getProvider = async () => {
      throw new Error("session gone");
    };
    const setState2 = mount();
    setState2(stateWith(connector));
    await statusListener?.("connected", "disconnected");
    await flush();

    handler?.cleanup?.();
    __resetSeededWallet();
    const setState3 = mount();
    setState3(stateWith(connector));
    await statusListener?.("connected", "disconnected");
    await flush();

    expect(mockFormo.connect.lastCall.args[1]?.providerName).to.equal("WalletConnect");
  });

  it("never blocks emission on the lookup", async () => {
    // getProvider that never resolves must not delay the connect.
    const connector = {
      ...makeConnector("Ledger Live"),
      getProvider: () => new Promise(() => undefined),
    };
    const setState = mount();
    setState(stateWith(connector));

    await statusListener?.("connected", "disconnected");
    await new Promise((r) => setTimeout(r, 300));

    expect(mockFormo.connect.called).to.equal(true);
    expect(mockFormo.connect.firstCall.args[1]?.providerName).to.equal("WalletConnect");
  });
});
