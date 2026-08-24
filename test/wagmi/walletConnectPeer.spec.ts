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

  const mount = (state: WagmiState) => {
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
      state,
    };
    const queryClient: QueryClient = {
      getMutationCache: () => ({ subscribe: () => () => undefined }),
      getQueryCache: () => ({ subscribe: () => () => undefined }),
    } as any;
    handler = new WagmiEventHandler(mockFormo, config, queryClient);
  };

  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("names the peer wallet on events once the lookup resolves", async () => {
    const connector = makeConnector("Ledger Live");
    mount(stateWith(connector));

    await statusListener?.("connected", "disconnected");
    await flush();

    expect(mockFormo.connect.called).to.equal(true);
    // The first connect fired synchronously, before the async peer lookup
    // could resolve: "WalletConnect" is the honest state at that instant.
    expect(mockFormo.connect.firstCall.args[1]?.providerName).to.equal("WalletConnect");

    // A later session for the same connector names the real wallet.
    handler?.cleanup?.();
    __resetSeededWallet();
    mount(stateWith(connector));
    await statusListener?.("connected", "disconnected");
    await flush();

    const last = mockFormo.connect.lastCall;
    expect(last.args[1]?.providerName).to.equal("Ledger Live");
  });

  it("keeps the connector's own name when the session has no peer", async () => {
    const connector = makeConnector(undefined);
    mount(stateWith(connector));

    await statusListener?.("connected", "disconnected");
    await flush();
    handler?.cleanup?.();
    __resetSeededWallet();
    mount(stateWith(connector));
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
    mount(stateWith(connector));

    await statusListener?.("connected", "disconnected");
    await flush();

    expect(mockFormo.connect.called).to.equal(true);
    expect(mockFormo.connect.firstCall.args[1]?.providerName).to.equal("WalletConnect");
  });
});
