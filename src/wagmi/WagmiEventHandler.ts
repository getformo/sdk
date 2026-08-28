/**
 * WagmiEventHandler
 *
 * Handles wallet event tracking by hooking into Wagmi v2's config.subscribe()
 * and TanStack Query's MutationCache. This replaces the EIP-1193 provider
 * wrapping approach when Wagmi mode is enabled.
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { SignatureStatus, TransactionStatus } from "../types/events";
import { logger } from "../logger";
import { readWalletConnectPeer, isUserRejectionError } from "../provider";
import {
  readBatchId,
  readBatchStatusCode,
  readBatchChainId,
  batchCallOutcome,
  batchReceiptForCall,
  BatchStatusResult,
} from "../evm/batch";
import {
  WagmiConfig,
  WagmiState,
  QueryClient,
  MutationCacheEvent,
  QueryCacheEvent,
  UnsubscribeFn,
  WagmiTrackingState,
  WagmiMutationKey,
} from "./types";
import {
  encodeWriteContractData,
  concatCalldataWithSuffix,
  extractFunctionArgs,
  buildSafeFunctionArgs,
} from "./utils";

/**
 * Built-in transaction fields that could collide with function args.
 * Defined at module level to avoid recreating on every method call.
 */
const RESERVED_FIELDS = new Set([
  "status",
  "chainId",
  "address",
  "data",
  "to",
  "value",
  "transactionHash",
  "function_name",
  "function_args",
]);

/**
 * Connections already announced to a destination during this page load.
 *
 * Deliberately module scoped rather than per handler or per FormoAnalytics
 * instance. The duplicate this prevents comes from the SDK instance itself
 * being rebuilt - a provider remount, an options change, HMR - while the
 * wallet never disconnected, and per-instance state cannot see that.
 *
 * A real disconnect clears the entry, so a genuine reconnect within the same
 * page load still emits. A new page load starts with a fresh module scope.
 */
const announcedConnections = new Set<string>();

/**
 * Connections announced, keyed by the wagmi connection OBJECT.
 *
 * Wagmi builds a fresh connection object on every `connect()`, and replaces it
 * whenever anything about the connection changes. So finding the SAME object
 * still in the store is proof that nothing happened in between - no
 * disconnect, no reconnect - and the marker can be trusted with no time limit
 * at all. That covers the case the grace period alone gets wrong: an SDK
 * unmounted for a long time while the wallet simply stayed connected.
 *
 * The address-keyed set above remains the fallback for the genuinely
 * ambiguous case, where the object was replaced but a chain switch and a
 * reconnect are indistinguishable after the fact.
 *
 * Weak, so a dead connection is collected rather than pinned.
 */
const announcedByConnection = new WeakMap<object, Set<string>>();

/**
 * Keyed by write key as well as address: two SDK instances for different write
 * keys are separate analytics destinations with separate queues, so the second
 * must still receive its own connect for the same wallet.
 *
 * The connector uid is NOT part of the key. Wagmi keeps that uid stable across
 * a disconnect and reconnect through the same connector, so including it never
 * distinguished one connection occurrence from the next. The observation
 * window below is what makes a reconnect emit again.
 */
const announceKey = (writeKey: string, address: string) =>
  `${writeKey}:${address.toLowerCase()}`;

/**
 * How long the markers stay trustworthy after the last handler goes away.
 *
 * A marker only means "already announced" while the SDK is actually watching
 * wagmi. With no handler mounted nothing observes a disconnect, so a wallet
 * that disconnects and reconnects in that window would otherwise look
 * unchanged and its genuine connect would be swallowed for the rest of the
 * page load.
 *
 * Rebuilding the SDK tears the old handler down and builds a new one, and
 * `FormoAnalytics.init()` is async, so the gap is real but short. This grace
 * period spans a rebuild and little else: markers survive it, and a longer
 * unmount discards them so the next connect is treated as new.
 */
export const MARKER_GRACE_MS = 3_000;

/**
 * Liveness is tracked PER WRITE KEY, because markers are.
 *
 * A global count would let one destination keep another's markers alive: with
 * destination B still mounted, A's would never expire, so a wallet that
 * disconnected and reconnected while A was unmounted would have its genuine
 * connect suppressed when A came back.
 */
const liveHandlers = new Map<string, number>();
const markerExpiry = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * @param adoptsLiveConnection whether the arriving handler actually found the
 *   announced connection still in place. Only then may it cancel the expiry:
 *   a replacement that mounts over a DISCONNECTED store has observed nothing,
 *   so cancelling would strand the markers for the rest of the page load and
 *   suppress a genuine connect hours later.
 */
function retainMarkers(writeKey: string, adoptsLiveConnection: boolean): void {
  liveHandlers.set(writeKey, (liveHandlers.get(writeKey) ?? 0) + 1);
  if (!adoptsLiveConnection) return;
  const pending = markerExpiry.get(writeKey);
  if (pending) {
    clearTimeout(pending);
    markerExpiry.delete(writeKey);
  }
}

function releaseMarkers(writeKey: string): boolean {
  const remaining = Math.max(0, (liveHandlers.get(writeKey) ?? 0) - 1);
  liveHandlers.set(writeKey, remaining);
  const wasLast = remaining === 0;
  if (remaining > 0 || markerExpiry.has(writeKey)) return wasLast;
  const timer = setTimeout(() => {
    markerExpiry.delete(writeKey);
    const prefix = `${writeKey}:`;
    announcedConnections.forEach((key) => {
      if (key.startsWith(prefix)) announcedConnections.delete(key);
    });
  }, MARKER_GRACE_MS);
  // Never hold a Node process (or a test run) open for this.
  (timer as unknown as { unref?: () => void }).unref?.();
  markerExpiry.set(writeKey, timer);
  return wasLast;
}

/**
 * The one handler allowed to EMIT for a given destination.
 *
 * Two handlers can be alive at once over the same wagmi config and write key:
 * Strict Mode, HMR, or an options change whose replacement mounts before the
 * old one is torn down - which the marker grace period explicitly supports.
 * Non-owners still track state, so whichever survives cleanup is already
 * correct and takes over immediately; they simply do not emit.
 */
const emittingOwners = new Map<string, WagmiEventHandler>();

/** Stable per-config id, so the owner key can span SDK instances. */
const configIds = new WeakMap<object, string>();
let nextConfigId = 0;
const ownerKey = (writeKey: string, config: WagmiConfig): string => {
  let id = configIds.get(config as unknown as object);
  if (!id) {
    id = `cfg${(nextConfigId += 1)}`;
    configIds.set(config as unknown as object, id);
  }
  return `${writeKey}:${id}`;
};

// User-rejection detection is shared with the EIP-1193 path (4001, the
// WalletConnect 5000-family, and viem's typed error): see
// provider/detection.ts for the dialects and why 4001 alone missed every
// WalletConnect rejection.
const isUserRejection = isUserRejectionError;

/**
 * Real wallet names behind WalletConnect connectors, resolved lazily.
 *
 * WalletConnect is a transport: the signing wallet (Ledger Live, MetaMask
 * Mobile, Safe, ...) names itself in the session's peer metadata, reachable
 * only through the connector's async `getProvider()`. Connect emission is
 * deliberately synchronous (see the marker comments below), so the lookup
 * can never be awaited in line - it is kicked fire-and-forget the first
 * time a WalletConnect connector is seen, and every event after resolution
 * carries the real wallet's name. The first connect may still say
 * "WalletConnect"; that is the honest state at that instant.
 *
 * HONEST STATUS: with the new-connection invalidation below, no event the
 * wagmi path emits TODAY observably carries the resolved name - connects
 * fire before resolution and rebuilds suppress re-emission. The cache
 * exists for the attribution work (wallet names on signature and
 * transaction events), which fires mid-session, after resolution.
 *
 * Names are keyed by the CONNECTOR (stable across a page's sessions) so
 * they actually serve reads; lookups are guarded per CONNECTION (wagmi
 * replaces the connection object per session), so every new session
 * re-resolves and OVERWRITES the name. A reconnect through the same
 * connector to a different wallet can therefore mislabel at most the one
 * event that fires between the new session's start and its resolution -
 * one microtask for an initialised connector - and self-corrects. The
 * alternative, keying names by connection, was tried and kept the name
 * from ever surfacing: the only reader that fires per session runs before
 * any lookup can resolve. WeakMaps, so nothing outlives its object.
 */
const walletConnectPeerNames = new WeakMap<object, string>();
const walletConnectPeerLookups = new WeakSet<object>();
/** The connection whose lookup may write the connector's name: always the
 * newest kicked one, so a slow resolution from a PREVIOUS session cannot
 * land after the current session's and overwrite it. */
const walletConnectPeerLatest = new WeakMap<object, object>();

/** Details of a broadcast we are waiting on a receipt for. */
type PendingTransaction = {
  address: string;
  /** Wallet attribution captured at broadcast; the receipt reuses it so a
   * connection change in between cannot relabel the confirmation. */
  providerName?: string;
  /**
   * Chain the transaction was broadcast on. Stored because a mutation may
   * name an explicit `chainId`, and the active chain can change between
   * broadcast and receipt; the confirmation must not be relabelled.
   */
  chainId?: number;
  /**
   * Whether the caller named the chain. An explicit chain outranks the
   * receipt query's; an inferred one only outranks the current chain.
   */
  chainIdWasExplicit?: boolean;
  data?: string;
  to?: string;
  value?: string;
  function_name?: string;
  function_args?: Record<string, unknown>;
  safeFunctionArgs?: Record<string, unknown>;
};

/**
 * Pending transactions, shared per destination rather than per handler.
 *
 * A broadcast observed by handler A, followed by a replacement B taking over
 * before the receipt arrives, otherwise loses the confirmation entirely: A no
 * longer emits because it is not the owner, and B has no record of the
 * broadcast to match the receipt against.
 */
const pendingTransactionsByDestination = new Map<
  string,
  Map<string, PendingTransaction>
>();

/**
 * A broadcast EIP-5792 batch we are waiting on `callsStatus` for.
 *
 * Keyed by the wallet's batch id, shared per destination for the same reason
 * as pending transactions: the handler that saw the `sendCalls` mutation may
 * be replaced before `useWaitForCallsStatus` settles, and the successor must
 * still be able to attribute the outcome.
 */
type PendingBatch = {
  address: string;
  /** Wallet attribution captured at broadcast, reused at settlement. */
  providerName?: string;
  chainId?: number;
  /**
   * Whether the caller named the chain. An explicit chain outranks the one
   * the settlement result reports; an inferred one does not - the wallet
   * can move chains while the prompt is up, and EIP-5792 v2 puts the chain
   * the batch actually settled on in the `wallet_getCallsStatus` response.
   */
  chainIdWasExplicit?: boolean;
  calls: Array<{
    to?: string;
    value?: string;
    data?: string;
  }>;
};

const pendingBatchesByDestination = new Map<string, Map<string, PendingBatch>>();

/**
 * Pending records outlive a rebuild by the same grace period as the markers.
 * The ordinary rebuild is cleanup THEN remount, so dropping them the instant
 * the last handler goes would lose the receipt for anything broadcast just
 * before teardown.
 */
const pendingTransactionExpiry = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function schedulePendingTransactionExpiry(key: string): void {
  if (pendingTransactionExpiry.has(key)) return;
  const timer = setTimeout(() => {
    pendingTransactionExpiry.delete(key);
    pendingTransactionsByDestination.delete(key);
    pendingBatchesByDestination.delete(key);
  }, MARKER_GRACE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  pendingTransactionExpiry.set(key, timer);
}

function cancelPendingTransactionExpiry(key: string): void {
  const timer = pendingTransactionExpiry.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingTransactionExpiry.delete(key);
}

/**
 * Has this destination already announced this wallet on this very connection?
 *
 * `exact` means the wagmi connection object is unchanged since the
 * announcement, which is proof nothing happened in between and holds however
 * long the SDK was away. `recent` means the object was replaced but the
 * announcement is still inside the observation window.
 */
function announcementState(
  key: string,
  connection?: object
): "exact" | "recent" | "none" {
  if (connection && announcedByConnection.get(connection)?.has(key)) {
    return "exact";
  }
  return announcedConnections.has(key) ? "recent" : "none";
}

/**
 * Undo an announcement claim whose emission failed.
 *
 * `markAnnounced()` is called before the event is handed to FormoAnalytics,
 * so the claim exists while the emission is in flight and a concurrent
 * handler cannot double-report. If that emission then fails, nothing was
 * reported - and leaving the claim standing means a retry or a replacement
 * handler treats the wallet as done, losing its connect for the rest of the
 * page load even after the queue recovers.
 */
function releaseAnnouncement(key: string, connection?: object): void {
  announcedConnections.delete(key);
  if (connection) announcedByConnection.get(connection)?.delete(key);
}

/**
 * Record a connection as announced.
 *
 * Deliberately unbounded. Entries are removed when the wallet disconnects,
 * and pruned against the live connections whenever a handler mounts, so the
 * set can only hold wallets that are actually connected right now. An earlier
 * revision carried a size cap as a backstop; with both of those in place it
 * was unreachable, and the test covering it passed with the cap removed.
 */
function markAnnounced(key: string, connection?: object): void {
  if (connection) {
    const keys = announcedByConnection.get(connection) ?? new Set<string>();
    keys.add(key);
    announcedByConnection.set(connection, keys);
  }
  announcedConnections.add(key);
}

/** Test hook. Real page loads reset this naturally. */
export function __resetSeededWallet(): void {
  emittingOwners.clear();
  pendingTransactionExpiry.forEach((t) => clearTimeout(t));
  pendingTransactionExpiry.clear();
  pendingTransactionsByDestination.clear();
  pendingBatchesByDestination.clear();
  announcedConnections.clear();
  liveHandlers.clear();
  markerExpiry.forEach((timer) => clearTimeout(timer));
  markerExpiry.clear();
}

/**
 * wagmi accepts an `account` as either a bare address or a viem Account
 * object. Normalise both to an address, or undefined when absent.
 */
/**
 * Coerce a wagmi/viem chain id to a number.
 *
 * An EIP-712 domain carries whatever the caller put in it, and viem accepts a
 * hex string or a bigint there as well as a number. Passing those straight
 * through would put a non-number in the event payload and defeat the numeric
 * comparison in `tracking.excludeChains`.
 */
function normalizeChainId(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = value.startsWith("0x") ? Number(value) : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function resolveAccountAddress(account: unknown): string | undefined {
  if (typeof account === "string") return account;
  if (account && typeof account === "object") {
    const address = (account as { address?: unknown }).address;
    if (typeof address === "string") return address;
  }
  return undefined;
}

/**
 * Clean up old entries from a Set to prevent memory leaks.
 * Removes oldest entries when size exceeds maxSize.
 *
 * @param set - The Set to clean up
 * @param maxSize - Maximum allowed size before cleanup (default: 1000)
 * @param removeCount - Number of entries to remove (default: 500)
 */
function cleanupOldEntries(
  set: Set<string>,
  maxSize = 1000,
  removeCount = 500
): void {
  if (set.size > maxSize) {
    const entries = Array.from(set);
    for (let i = 0; i < removeCount && i < entries.length; i++) {
      set.delete(entries[i]);
    }
  }
}

export class WagmiEventHandler {
  private formo: FormoAnalytics;
  private wagmiConfig: WagmiConfig;
  private queryClient?: QueryClient;
  private unsubscribers: UnsubscribeFn[] = [];
  private trackingState: WagmiTrackingState = {
    isProcessing: false,
  };

  /**
   * Set by `cleanup()`. Every deferred emission checks it, so a handler that
   * has been torn down cannot push an event into a queue the replacement SDK
   * instance no longer owns.
   */
  private disposed = false;

  /**
   * Drop markers for wallets wagmi no longer holds, and report whether any
   * announced wallet is still connected.
   *
   * Called when a handler mounts. Cancelling the expiry timer on the strength
   * of "some connection exists" let a marker for a wallet that had since
   * disconnected survive indefinitely, suppressing its genuine reconnect.
   */
  private pruneMarkersForLostWallets(): boolean {
    let state: WagmiState;
    try {
      state = this.getState();
    } catch {
      return false;
    }
    const prefix = `${this.formo.writeKey}:`;
    const live = new Set<string>();
    state.connections.forEach((connection) => {
      connection.accounts.forEach((a: string) =>
        live.add(announceKey(this.formo.writeKey, a))
      );
    });

    let announcedStillConnected = false;
    announcedConnections.forEach((key) => {
      if (!key.startsWith(prefix)) return;
      if (live.has(key)) announcedStillConnected = true;
      else announcedConnections.delete(key);
    });
    return announcedStillConnected;
  }

  /** Identifies this handler's destination for emit-ownership. */
  private ownerKey?: string;

  /**
   * Whether this handler is the one allowed to emit for its destination.
   *
   * A handler that lost the race still tracks state, so it is ready to take
   * over the moment the owner goes away; it just does not emit.
   */
  private get isEmittingOwner(): boolean {
    if (!this.ownerKey) return true;
    const owner = emittingOwners.get(this.ownerKey);
    if (!owner) {
      // Nobody holds it - the previous owner was torn down. Claim it.
      emittingOwners.set(this.ownerKey, this);
      return true;
    }
    return owner === this;
  }

  /** Reentrancy guard for `reconcileWithLiveState()`. */
  private reconciling = false;

  /**
   * Ticket for each active-connection transition. Emissions are awaited, and
   * wagmi can move again in that window; a continuation whose ticket is no
   * longer current must not write stale state over the newer one.
   */
  private transitionGeneration = 0;

  /**
   * A chain reported while wagmi was not `connected`, so the chain callback
   * had to drop it. Replayed by `reconcileWithLiveState()`.
   */
  private pendingChainId?: number;

  /**
   * A `disconnected` status that arrived while the lock was held. Final-state
   * reconciliation cannot see a disconnect/reconnect cycle that completed
   * inside that window, so this records that one happened.
   */
  private missedDisconnect = false;

  /**
   * Track processed mutation states to prevent duplicate event emissions
   * Key format: `${mutationId}:${status}`
   */
  private processedMutations = new Set<string>();

  /**
   * Track processed query states to prevent duplicate event emissions
   * Key format: `${queryHash}:${status}`
   */
  private processedQueries = new Set<string>();

  /**
   * Store transaction details from BROADCASTED events for use in CONFIRMED/REVERTED
   * Key: transactionHash, Value: transaction details including the original sender address
   */
  /**
   * Shared per destination, not per handler.
   *
   * A broadcast observed by handler A, followed by a replacement B taking
   * over before the receipt arrives, used to lose the confirmation entirely:
   * A no longer emits because it is not the owner, and B had no record of the
   * broadcast to match the receipt against.
   */
  private get pendingTransactions(): Map<string, PendingTransaction> {
    const key = this.ownerKey ?? "";
    let map = pendingTransactionsByDestination.get(key);
    if (!map) {
      map = new Map();
      pendingTransactionsByDestination.set(key, map);
    }
    return map;
  }

  /** Broadcast batches awaiting `callsStatus`, shared like the map above. */
  private get pendingBatches(): Map<string, PendingBatch> {
    const key = this.ownerKey ?? "";
    let map = pendingBatchesByDestination.get(key);
    if (!map) {
      map = new Map();
      pendingBatchesByDestination.set(key, map);
    }
    return map;
  }

  constructor(
    formoAnalytics: FormoAnalytics,
    wagmiConfig: WagmiConfig,
    queryClient?: QueryClient
  ) {
    this.formo = formoAnalytics;
    this.wagmiConfig = wagmiConfig;
    this.queryClient = queryClient;

    logger.info("WagmiEventHandler: Initializing Wagmi integration");

    // Keep the page-load markers alive across an SDK rebuild. Must run before
    // the seed, so a handler created moments after its predecessor was torn
    // down still sees what that predecessor announced.
    // Only a handler that finds an ANNOUNCED wallet still connected may hold
    // the markers open. Mounting over a disconnected store has observed
    // nothing; mounting over a DIFFERENT wallet is worse still - it would
    // preserve the previous wallet's marker and suppress its genuine
    // reconnect for the rest of the page load. Markers for wallets no longer
    // in `state.connections` are dropped outright.
    const livesOverConnection = this.pruneMarkersForLostWallets();
    retainMarkers(this.formo.writeKey, livesOverConnection);

    // Claim the right to emit for this destination. The NEWEST handler always
    // wins, deliberately: an app that rebuilds without calling `cleanup()`
    // leaks the old handler, and letting that stale one keep ownership would
    // silence the live one for the rest of the page load - far worse than the
    // duplicate events this is here to prevent.
    this.ownerKey = ownerKey(this.formo.writeKey, wagmiConfig);
    emittingOwners.set(this.ownerKey, this);
    // A remount for this destination cancels the pending-record expiry the
    // previous handler started.
    cancelPendingTransactionExpiry(this.ownerKey);

    // Set up connection/disconnection/chain listeners
    this.setupConnectionListeners();

    // Adopt a wallet that connected before this handler existed.
    this.seedFromCurrentState();

    // Set up mutation and query tracking if QueryClient is provided
    if (this.queryClient) {
      this.setupMutationTracking();
      this.setupQueryTracking();
    } else {
      logger.warn(
        "WagmiEventHandler: QueryClient not provided, signature and transaction events will not be tracked"
      );
    }
  }

  /**
   * Set up listeners for wallet connection, disconnection, and chain changes
   */
  private setupConnectionListeners(): void {
    logger.info("WagmiEventHandler: Setting up connection listeners");

    // Subscribe to status changes (connect/disconnect)
    const statusUnsubscribe = this.wagmiConfig.subscribe(
      (state: WagmiState) => state.status,
      (status, prevStatus) => {
        this.handleStatusChange(status, prevStatus);
      }
    );
    this.unsubscribers.push(statusUnsubscribe);

    // Subscribe to chain ID changes.
    //
    // Selects the ACTIVE CONNECTION's chain, with the global as a fallback -
    // the same rule every read site here uses. Selecting only `state.chainId`
    // meant that with several connections, or with `syncConnectedChain: false`,
    // the active connection could move to a new chain while the global stayed
    // put: no callback ran, and both the tracked chain and Formo's central
    // chain silently went stale for every later event.
    const chainIdUnsubscribe = this.wagmiConfig.subscribe(
      (state: WagmiState) =>
        this.getActiveConnectionChainId(state) ?? state.chainId,
      (chainId, prevChainId) => {
        this.handleChainChange(chainId, prevChainId);
      }
    );
    this.unsubscribers.push(chainIdUnsubscribe);

    // Subscribe to the active connection as a whole: its connector id AND its
    // address, as one string.
    //
    // `state.status` is a single global value, so it stays "connected" when a
    // user switches account inside an already-connected wallet. Without this
    // the switch is invisible: no event, and the tracked address goes stale
    // and mis-attributes every later signature and transaction.
    //
    // The connector id has to be in the key too. Selecting the address alone
    // missed the case where two connectors hold the SAME account - MetaMask
    // and Rabby over one hardware wallet, say - and the current one
    // disconnects: wagmi falls back to the other, the address is unchanged, so
    // nothing fired and the disconnect was lost for good.
    const connectionUnsubscribe = this.wagmiConfig.subscribe(
      (state: WagmiState) =>
        `${state.current ?? ""}|${this.getConnectedAddress(state) ?? ""}`,
      (key, prevKey) => {
        const [, address] = key.split("|");
        const [, prevAddress] = (prevKey ?? "|").split("|");
        // A connector switch keeps status "connected", so the status
        // subscription never re-wraps; the NEW active connection's provider
        // must be instrumented from here or its imperative calls are lost.
        this.wrapActiveConnectorProvider(this.getState());
        this.handleActiveAddressChange(
          address || undefined,
          prevAddress || undefined
        );
      }
    );
    this.unsubscribers.push(connectionUnsubscribe);

    logger.info("WagmiEventHandler: Connection listeners set up successfully");
  }

  /**
   * Adopt a connection that already existed when this handler was created.
   *
   * `config.subscribe` reports *changes* only, so a wallet restored by wagmi's
   * mount-time `reconnect()` is invisible to a handler built afterwards. That
   * is the normal case whenever the host app loads the SDK lazily (dynamic
   * import, `requestIdleCallback`) and can also happen on a plain mount, since
   * `FormoAnalytics.init()` and wagmi's reconnect are both async and race.
   *
   * Without this seed the whole session is lost: no connect event, and
   * `lastAddress` stays undefined so the signature and transaction handlers
   * drop their events too, and the eventual disconnect carries neither address
   * nor chain id.
   *
   * `subscribe(..., { fireImmediately: true })` is not a substitute. It reports
   * the current value with no distinct previous value, so the connect branch's
   * `prevStatus !== "connected"` test never passes, and wagmi v3 does not
   * honour the option at all.
   *
   * Deliberately synchronous, and deliberately does NOT take the
   * `isProcessing` lock. Everything that mutates tracking state runs before
   * any await, so no status change can interleave with it. Holding the lock
   * across the `connect()` emission instead would make `handleStatusChange()`
   * drop - not defer - a disconnect or wallet switch that lands in that
   * window, which is exactly when a lazily loaded SDK is racing app activity.
   *
   * A genuine `connected` transition cannot double-emit alongside this seed.
   * `config.subscribe` only fires on change, and the connect branch treats a
   * re-entry for an already-tracked address as a no-op (or a chain change).
   */
  private seedFromCurrentState(): void {
    // Fire-and-forget here: the seed is synchronous by design, so its own
    // connect may carry the generic name; the status flow awaits instead.
    // A throwing store must not break construction.
    try {
      const snapshot = this.getState();
      this.kickWalletConnectPeerLookup(snapshot);
      this.wrapActiveConnectorProvider(snapshot);
    } catch {
      /* the seed continues; names fall back to the connector's own */
    }

    try {
      const state = this.getState();
      if (state.status !== "connected") {
        return;
      }

      const address = this.getConnectedAddress(state);
      // The active connection's chain is authoritative. `state.chainId` is a
      // single global value that can lag or describe a different connection,
      // and with `syncConnectedChain: false` it stays on the chain the APP
      // selected while the connection reports what the WALLET is on.
      const chainId = this.getActiveConnectionChainId(state) ?? state.chainId;

      if (!address || chainId === undefined) {
        logger.debug(
          "WagmiEventHandler: Connected at init but address or chainId is missing, nothing to seed",
          { address, chainId }
        );
        return;
      }

      logger.info(
        "WagmiEventHandler: Adopting connection that predates this handler",
        { address, chainId }
      );

      // Sync central state first so tracking.excludeChains is enforced even
      // when connect autocapture is disabled.
      this.formo.syncWalletState({ chainId, address });

      // Only adopt the wallet privately if central state actually accepted it.
      // While tracking is suppressed (opt-out, excluded host or path)
      // syncWalletState deliberately refuses to learn a wallet. Retaining it
      // here anyway would let the mutation handlers attribute signatures and
      // transactions to an address the SDK has decided it must not know -
      // including on a chain that excludeChains rejects, since that check
      // reads the central field rather than the event payload.
      //
      // Compared case-insensitively: syncWalletState stores the checksummed
      // form, which need not match the casing wagmi reported.
      if (
        this.formo.currentAddress?.toLowerCase() !== address.toLowerCase()
      ) {
        logger.debug(
          "WagmiEventHandler: Central state declined the connection, not seeding",
          { address, chainId }
        );
        return;
      }

      // Adopt the tracking state either way - the mutation handlers need an
      // address - but only emit the first time this page load adopts this
      // wallet. A rebuilt SDK instance over an unchanged connection is a
      // lifecycle event, not a user action.
      this.trackingState.lastAddress = address;
      this.trackingState.lastChainId = chainId;
      this.trackingState.lastStatus = state.status;
      // Always record the connection, including on the deduplicated path
      // below. A replacement handler that adopts a live connection must be
      // able to clear the right marker when it later sees the disconnect.
      this.trackingState.lastConnectionId = state.current;

      if (!this.formo.isAutocaptureEnabled("connect") || !this.isEmittingOwner) {
        // Nothing was announced, so nothing may be marked. Marking here would
        // make a later rebuild with connect autocapture enabled - which is
        // exactly how FormoAnalyticsProvider applies an options change - find
        // the marker and stay silent about a wallet it never reported.
        logger.debug(
          "WagmiEventHandler: Connect autocapture disabled, adopted without emitting",
          { address, chainId }
        );
        return;
      }

      // Nothing that will not actually be sent may be marked. `syncWalletState`
      // accepts a wallet that `trackEvent()` then silently drops - `tracking:
      // false`, or a chain in `excludeChains` - and marking it would make the
      // rebuild that turns tracking back on find the marker and stay quiet
      // about the wallet for the rest of the page load.
      if (!this.formo.willTrackEvent(chainId)) {
        logger.debug(
          "WagmiEventHandler: Connect would not be tracked, adopted without emitting",
          { address, chainId }
        );
        return;
      }

      const walletKey = announceKey(this.formo.writeKey, address);
      const connection = state.current
        ? state.connections.get(state.current)
        : undefined;
      if (announcementState(walletKey, connection) !== "none") {
        logger.debug(
          "WagmiEventHandler: Wallet already adopted this page load, not re-emitting connect",
          { address }
        );
        return;
      }
      markAnnounced(walletKey, connection);

      {
        const connectorName = this.getConnectorName(state);
        // Invoked synchronously, only the completion is fire-and-forget.
        //
        // Deferring the call itself to a microtask and guarding it on
        // `disposed` loses the event outright: a rebuild that tears this
        // handler down before the microtask runs leaves the marker standing,
        // so the replacement handler suppresses its own connect while this one
        // declines to emit. Nobody reports the wallet. Calling now means the
        // marker and the emission are decided together, and a rebuild can only
        // arrive after the event is already handed to FormoAnalytics.
        void Promise.resolve(
          this.formo.connect(
            { chainId, address },
            {
              ...(connectorName && { providerName: connectorName }),
            }
          )
        ).catch((error) => {
          // The marker is a claim, not a record. If the emission failed the
          // wallet was never reported, so release it - otherwise a retry or a
          // replacement handler treats it as done and the connect is lost for
          // the rest of the page load even once the queue recovers.
          releaseAnnouncement(walletKey, connection);
          logger.error(
            "WagmiEventHandler: Error emitting seeded connect event:",
            error
          );
        });
      }
    } catch (error) {
      logger.error(
        "WagmiEventHandler: Error seeding from current state:",
        error
      );
    }
  }

  /**
   * Re-assert the tracked wallet into central state.
   *
   * Needed when an awaited emission clears the central namespace after a newer
   * transition has already adopted a different wallet: the two then disagree,
   * and `trackEvent()` reads the central one.
   */
  private restoreCentralStateFromTracking(): void {
    const { lastAddress, lastChainId } = this.trackingState;
    if (!lastAddress || lastChainId === undefined) return;
    // Compares the CHAIN as well as the address.
    //
    // A chain switch on an excluded path is deliberately refused by
    // `syncWalletState()`, so central state keeps the old chain while
    // `lastChainId` moves on. Matching on the address alone returned here,
    // and after navigating back to an allowed path the events that fall back
    // to the central chain were gated against a chain the wallet had left -
    // bypassing an exclusion covering where it actually was.
    if (
      this.formo.currentAddress?.toLowerCase() === lastAddress.toLowerCase() &&
      this.formo.currentChainId === lastChainId
    ) {
      return;
    }
    logger.info(
      "WagmiEventHandler: Restoring central state a stale disconnect cleared",
      { address: lastAddress, chainId: lastChainId }
    );
    this.formo.syncWalletState({ chainId: lastChainId, address: lastAddress });
  }

  /**
   * Drop the wallet this handler is attributing events to.
   *
   * Used whenever central state refuses to hold the wallet - an excluded path
   * or chain, or an opt-out. Keeping the address privately would let the
   * mutation handlers label signatures and transactions with an identity the
   * SDK has deliberately declined to know.
   */
  private releaseTrackedWallet(): void {
    const previous = this.trackingState.lastAddress;
    this.trackingState.lastAddress = undefined;
    this.trackingState.lastChainId = undefined;
    this.trackingState.lastConnectionId = undefined;
    if (previous) {
      announcedConnections.delete(announceKey(this.formo.writeKey, previous));
    }
  }

  /**
   * Adopt the live connection if one exists and nothing is tracked yet.
   *
   * `seedFromCurrentState()` runs once at construction and can legitimately
   * decline: wagmi may still be filling `connections`, the chain may not have
   * arrived, or tracking may be suppressed because the app happens to be on an
   * excluded path. `config.subscribe` only reports *changes*, so an unchanged
   * connection would then stay invisible for the rest of the page load and
   * every later signature and transaction would be dropped.
   *
   * Idempotent. The page-load marker keeps it from re-emitting a connect for a
   * wallet already announced, so this is safe to call from any listener.
   */
  public retryAdoption(): void {
    if (this.disposed) return;
    // The cached wallet may no longer be the live one. While tracking is
    // suppressed a user can disconnect, or switch account inside the same
    // wallet - which moves only the connection's accounts, so neither the
    // status nor the chain subscription fires and nothing tells this handler.
    // Restoring the cached wallet then resurrects an address the user has
    // left, and the marker makes the check below return before the live one
    // is ever adopted.
    if (this.trackingState.lastAddress && !this.tracksLiveWallet()) {
      logger.debug(
        "WagmiEventHandler: Tracked wallet is no longer the live one, releasing before retry",
        { tracked: this.trackingState.lastAddress }
      );
      this.releaseTrackedWallet();
    }

    // Central state can have been cleared underneath a wallet this handler is
    // still tracking: `optOutTracking()` calls `reset()`, which wipes
    // `currentAddress` / `currentChainId` while the handler keeps its wallet.
    // Left unreconciled, later events carry no wallet at all - and
    // `shouldTrack()` sees no chain, so `excludeChains` stops excluding.
    this.resyncCentralState();

    // Adopted is not the same as announced. A wallet connected on an excluded
    // chain, or while tracking was off, is adopted so mutations can be
    // attributed, but its connect is deliberately not emitted or marked. If
    // this returned merely because an address is present, that wallet would
    // never be reported once the chain or configuration allowed it.
    if (this.trackingState.lastAddress && this.isCurrentWalletAnnounced()) {
      return;
    }
    this.seedFromCurrentState();
  }

  /** Whether the wallet this handler tracks is the one wagmi currently has. */
  private tracksLiveWallet(): boolean {
    const tracked = this.trackingState.lastAddress;
    if (!tracked) return false;
    try {
      const state = this.getState();
      if (state.status !== "connected") return false;
      const live = this.getConnectedAddress(state);
      return !!live && live.toLowerCase() === tracked.toLowerCase();
    } catch (error) {
      logger.error("WagmiEventHandler: Error reading state to compare wallets:", error);
      return false;
    }
  }

  /**
   * Put the tracked wallet back into central state without emitting anything.
   *
   * Used when the two have diverged for a reason that is not a wallet change:
   * an opt-out `reset()`, or a stale disconnect completing after a newer
   * transition adopted a different wallet.
   */
  private resyncCentralState(): void {
    const { lastAddress, lastChainId } = this.trackingState;
    if (!lastAddress || lastChainId === undefined) return;
    // Compares the CHAIN as well as the address.
    //
    // A chain switch on an excluded path is deliberately refused by
    // `syncWalletState()`, so central state keeps the old chain while
    // `lastChainId` moves on. Matching on the address alone returned here,
    // and after navigating back to an allowed path the events that fall back
    // to the central chain were gated against a chain the wallet had left -
    // bypassing an exclusion covering where it actually was.
    if (
      this.formo.currentAddress?.toLowerCase() === lastAddress.toLowerCase() &&
      this.formo.currentChainId === lastChainId
    ) {
      return;
    }
    logger.info("WagmiEventHandler: Re-syncing central state for a tracked wallet", {
      address: lastAddress,
      chainId: lastChainId,
    });
    this.formo.syncWalletState({ chainId: lastChainId, address: lastAddress });
  }

  /** Whether the wallet currently tracked has already had a connect emitted. */
  private isCurrentWalletAnnounced(): boolean {
    const address = this.trackingState.lastAddress;
    if (!address) return false;
    let connection: object | undefined;
    try {
      const state = this.getState();
      connection = state.current
        ? state.connections.get(state.current)
        : undefined;
    } catch {
      /* fall back to the address-keyed marker */
    }
    return (
      announcementState(announceKey(this.formo.writeKey, address), connection) !==
      "none"
    );
  }

  /**
   * Handle status changes (connect/disconnect)
   */
  private async handleStatusChange(
    status: WagmiState["status"],
    prevStatus: WagmiState["status"]
  ): Promise<void> {
    if (status === "disconnected" || status === "reconnecting") {
      // The wrapped session is over - or, for "reconnecting", about to be
      // replaced without ever passing through "disconnected". This must
      // run for EVERY such transition, before the processing lock and
      // regardless of whether a wallet was being tracked, or a rapid
      // same-connector reconnect retains the old provider and the chain
      // callback writes the new session's chain onto it. The generation
      // bump invalidates every wrap still in flight from the ended
      // session, resolved or not. The "connected" that follows re-wraps.
      this.wrapSessionGeneration += 1;
      this.fallbackConnector = undefined;
      this.fallbackProvider = undefined;
    }

    // Prevent concurrent processing
    if (this.trackingState.isProcessing) {
      // Dropped, not queued - but remember that a disconnect went past.
      //
      // Reconciliation compares only the FINAL state, so a wallet that
      // disconnects and reconnects entirely inside this window looks
      // unchanged and neither its disconnect nor its genuine reconnect is
      // ever reported. Recording the transient lets reconciliation tell that
      // cycle apart from nothing having happened at all.
      if (status === "disconnected") {
        this.missedDisconnect = true;
      }
      logger.debug("WagmiEventHandler: Already processing status change, skipping");
      return;
    }

    this.trackingState.isProcessing = true;

    // Start resolving the wallet behind a WalletConnect session. NEVER
    // awaited: every path from a store signal to its emission is
    // synchronous by design, and an await here reorders transitions (it
    // demonstrably drops connects under rapid connect/disconnect cycles).
    try {
      const snapshot = this.getState();
      this.kickWalletConnectPeerLookup(snapshot);
      this.wrapActiveConnectorProvider(snapshot);
    } catch {
      // A throwing store must not break the status flow.
    }

    // A status change outranks any connection transition still in flight. A
    // full disconnect advances no ticket of its own, so without this an older
    // fallback continuation could resume and announce a wallet wagmi no longer
    // has.
    this.transitionGeneration += 1;

    try {
      const state = this.getState();
      const address = this.getConnectedAddress(state);
      // As above: prefer the chain of the connection that is current.
      const chainId = this.getActiveConnectionChainId(state) ?? state.chainId;

      logger.info("WagmiEventHandler: Status changed", {
        status,
        prevStatus,
        address,
        chainId,
      });

      // Handle disconnect.
      //
      // Keyed on having a tracked wallet rather than on `prevStatus ===
      // "connected"`, because wagmi routes a failing `reconnect()` through
      // `connected -> reconnecting -> disconnected`. Testing prevStatus alone
      // silently drops that disconnect and leaves the wallet marked connected
      // forever.
      if (status === "disconnected" && this.trackingState.lastAddress) {
        // Snapshot and clear BEFORE emitting. The emission is awaited while
        // `isProcessing` is held, and a status change arriving in that window
        // is dropped rather than deferred. Clearing first means the wallet is
        // already gone from tracking state when that happens, so a later
        // reconnect of the same wallet is not mistaken for a re-entry and
        // silently swallowed.
        const disconnectedAddress = this.trackingState.lastAddress;
        const disconnectedChainId = this.trackingState.lastChainId;
        this.trackingState.lastConnectionId = undefined;
        this.trackingState.lastAddress = undefined;
        this.trackingState.lastChainId = undefined;
        this.pendingChainId = undefined;
        this.missedDisconnect = false;
        // A real disconnect ends the adoption, so a genuine reconnect later in
        // this same page load emits again.
        announcedConnections.delete(
          announceKey(this.formo.writeKey, disconnectedAddress)
        );

        // Emit BEFORE clearing central state. `disconnect()` gates on
        // `shouldTrack()`, which reads `currentChainId`, so clearing first
        // would hide a `tracking.excludeChains` chain from its own exclusion
        // check and emit the very event the exclusion forbids. `disconnect()`
        // clears the chain namespace itself once it has emitted.
        if (this.formo.isAutocaptureEnabled("disconnect") && this.isEmittingOwner) {
          await this.formo.disconnect({
            chainId: disconnectedChainId,
            address: disconnectedAddress,
          });
        } else {
          // Nothing to emit, but central state must still be cleared so a
          // later event cannot carry a stale excluded/!excluded chainId.
          this.formo.syncWalletState({ chainId: disconnectedChainId });
        }
      }

      // Handle connect
      if (status === "connected" && prevStatus !== "connected") {
        if (address && chainId !== undefined) {
          // wagmi flaps `connected -> reconnecting -> connected` when a
          // reconnect succeeds, and that final transition satisfies
          // `prevStatus !== "connected"`. The wallet never actually changed,
          // so re-emitting would double count it - either against the seed
          // from construction or against the previous connect.
          //
          // Identity is the ADDRESS alone. A reconnect that lands on a
          // different chain is still the same session, so it is a chain
          // transition, not a new connection.
          // Case-insensitive: a wallet can report the same account with
          // different casing across a reconnect, and a case-only difference is
          // not a new wallet.
          if (
            this.trackingState.lastAddress?.toLowerCase() ===
            address.toLowerCase()
          ) {
            if (this.trackingState.lastChainId !== chainId) {
              // Normally re-sync only: the chainId subscription observes this
              // same state update and owns the `chain` emission, so emitting
              // here too would double count it.
              //
              // The exception is a chain the subscription already had to drop
              // because wagmi was still `reconnecting` when it arrived. In
              // that case nothing else will ever report it, so hand it back to
              // the chain handler, which syncs and emits.
              if (this.pendingChainId === chainId) {
                this.pendingChainId = undefined;
                logger.info(
                  "WagmiEventHandler: Re-entry carries a chain the subscription dropped, emitting it",
                  { address, from: this.trackingState.lastChainId, to: chainId }
                );
                await this.handleChainChange(
                  chainId,
                  this.trackingState.lastChainId
                );
                this.trackingState.lastStatus = status;
                return;
              }

              logger.info(
                "WagmiEventHandler: Tracked wallet re-entered connected on a different chain",
                { address, from: this.trackingState.lastChainId, to: chainId }
              );
              // Sync first, then adopt only if central state accepted it.
              // Writing the private chain first would let the mutation
              // handlers label events with a chain that `shouldTrack()` is
              // still excluding, because that gate reads the central field
              // rather than the event payload.
              this.formo.syncWalletState({ chainId, address });
              if (
                this.formo.currentAddress?.toLowerCase() ===
                address.toLowerCase()
              ) {
                this.trackingState.lastChainId = chainId;
              } else {
                logger.debug(
                  "WagmiEventHandler: Central state declined the re-entry chain, dropping the wallet",
                  { address, chainId }
                );
                this.releaseTrackedWallet();
              }
            } else {
              logger.debug(
                "WagmiEventHandler: Ignoring re-entry to connected for an already tracked wallet",
                { address, chainId }
              );
            }
            this.trackingState.lastStatus = status;
            return;
          }

          // Sync central state first so tracking.excludeChains is enforced
          // even when connect autocapture is disabled.
          this.formo.syncWalletState({ chainId, address });

          // Same rule as the seed and the account-switch path: while tracking
          // is suppressed, syncWalletState refuses to learn a wallet, and
          // retaining it privately would let the mutation handlers attribute
          // events to an address the SDK declined to know.
          if (
            this.formo.currentAddress?.toLowerCase() !== address.toLowerCase()
          ) {
            logger.debug(
              "WagmiEventHandler: Central state declined the connection, not adopting",
              { address, chainId }
            );
            this.trackingState.lastStatus = status;
            return;
          }

          // A wallet superseded without an intervening `disconnected` - a
          // `reconnecting` flap landing on a different account - is handled by
          // `reconcileWithLiveState()`, which releases the old wallet (and its
          // marker) before re-seeding. Nothing to do here.
          this.trackingState.lastAddress = address;
          this.trackingState.lastChainId = chainId;
          this.trackingState.lastConnectionId = state.current;

          if (
            this.formo.isAutocaptureEnabled("connect") &&
            this.isEmittingOwner &&
            this.formo.willTrackEvent(chainId)
          ) {
            // Record it in the page-load marker as well. Without this only
            // seed-adopted wallets were deduplicated, so a wallet that
            // connected while this handler was alive would be re-emitted by
            // the seed of a rebuilt handler over the very same connection.
            //
            // Consulted as well as written. Two handlers can overlap on one
            // wagmi config - Strict Mode, or an options change whose
            // replacement mounts before the old one is torn down - and both
            // observe the same `disconnected -> connected` transition. Without
            // this check each emitted its own connect for one user action.
            // A genuine reconnect is unaffected: the disconnect path removes
            // the marker, so the next connect is unmarked again.
            const walletKey = announceKey(this.formo.writeKey, address);
            const connection = state.current
              ? state.connections.get(state.current)
              : undefined;
            if (announcementState(walletKey, connection) !== "none") {
              logger.debug(
                "WagmiEventHandler: Connect already announced for this wallet, not emitting again",
                { address }
              );
              this.trackingState.lastStatus = status;
              return;
            }
            markAnnounced(walletKey, connection);
            const connectorName = this.getConnectorName(state);
            try {
              await this.formo.connect(
                { chainId, address },
                {
                  ...(connectorName && { providerName: connectorName }),
                }
              );
            } catch (error) {
              // As in the seed: an emission that failed reported nothing, so
              // the claim must not stand.
              releaseAnnouncement(walletKey, connection);
              throw error;
            }
          }
        }
      }

      this.trackingState.lastStatus = status;
    } catch (error) {
      logger.error("WagmiEventHandler: Error handling status change:", error);
    } finally {
      this.trackingState.isProcessing = false;
      // A status change that arrived while the lock was held was dropped, not
      // queued. Reconcile against live state so the handler cannot be left
      // permanently disagreeing with wagmi.
      this.reconcileWithLiveState();
    }
  }

  /**
   * Re-run the status logic when the handler's view diverges from wagmi.
   *
   * `handleStatusChange()` drops - rather than defers - anything that arrives
   * while it holds `isProcessing`, and it holds that lock across an awaited
   * `connect()` / `disconnect()` emission. A wallet that reconnects inside
   * that window would otherwise leave the handler believing it is
   * disconnected for the rest of the page load, silently dropping every later
   * signature and transaction. The mirror case leaves a disconnected wallet
   * marked connected.
   *
   * Converges: each pass either adopts the live wallet or releases the tracked
   * one, so the next pass finds the two in agreement and returns.
   */
  private reconcileWithLiveState(): void {
    if (this.disposed || this.trackingState.isProcessing) return;
    if (this.reconciling) return;

    let state: WagmiState;
    try {
      state = this.getState();
    } catch (error) {
      logger.error("WagmiEventHandler: Error reading state to reconcile:", error);
      return;
    }

    // `connecting` and `reconnecting` are transient: the wallet has not gone
    // anywhere, wagmi is mid-handshake. Treating them as disconnected made
    // reconciliation synthesize a disconnect for an ordinary reconnect flap
    // and then emit a second connect when it completed - two spurious events
    // for a wallet that never left.
    if (state.status !== "connected" && state.status !== "disconnected") {
      return;
    }

    const live =
      state.status === "connected" ? this.getConnectedAddress(state) : undefined;
    const tracked = this.trackingState.lastAddress;

    if (!live && !tracked) return;
    if (live && tracked) {
      if (live.toLowerCase() === tracked.toLowerCase()) {
        if (this.missedDisconnect) {
          // The wallet went away and came back entirely while the lock was
          // held. The addresses match, but this is a new session: report the
          // disconnect, then let the reconnect announce itself.
          this.missedDisconnect = false;
          logger.info(
            "WagmiEventHandler: A disconnect/reconnect cycle completed while the lock was held",
            { address: live }
          );
          this.reconciling = true;
          try {
            void this.handleStatusChange("disconnected", "connected").then(() =>
              this.retryAdoption()
            );
          } finally {
            this.reconciling = false;
          }
          return;
        }

        // Same wallet. Replay a chain change the chain callback had to drop
        // because wagmi was still `reconnecting` at the time - the status
        // callback that would have covered it was then dropped by the
        // processing guard, so without this both the tracked and the central
        // chain keep describing the chain the wallet has already left.
        //
        // Deliberately keyed on a chain the callback actually dropped rather
        // than on any difference: in the ordinary flap the chain subscription
        // still owns the emission, and reconciling on difference alone would
        // double count it.
        // A disconnect that completed after a newer transition re-adopted this
        // same wallet clears the central namespace on its way out. Private
        // tracking still names the wallet while central state is empty, and
        // `trackEvent()` reads the central one - so later events lose their
        // wallet entirely. Put it back.
        this.resyncCentralState();

        const dropped = this.pendingChainId;
        if (dropped !== undefined) {
          this.pendingChainId = undefined;
          if (dropped !== this.trackingState.lastChainId) {
            logger.info(
              "WagmiEventHandler: Replaying a chain change dropped while reconnecting",
              { address: live, from: this.trackingState.lastChainId, to: dropped }
            );
            void this.handleChainChange(dropped, this.trackingState.lastChainId);
          }
        }
        return;
      }
      // Different wallet. Wagmi moved from one to another while the lock was
      // held, so BOTH status callbacks were dropped. Returning here would
      // leave every later signature and transaction attributed to the wallet
      // the user has already left.
      logger.info(
        "WagmiEventHandler: Wallet changed while the lock was held, re-adopting",
        { from: tracked, to: live }
      );
      this.reconciling = true;
      try {
        this.releaseTrackedWallet();
        this.seedFromCurrentState();
      } finally {
        this.reconciling = false;
      }
      return;
    }

    this.reconciling = true;
    try {
      if (live) {
        logger.info(
          "WagmiEventHandler: Reconnect landed while the lock was held, adopting it",
          { address: live }
        );
        this.retryAdoption();
      } else {
        logger.info(
          "WagmiEventHandler: Disconnect landed while the lock was held, applying it",
          { address: tracked }
        );
        void this.handleStatusChange("disconnected", "connected");
      }
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Handle a switch to a different account on an already-connected wallet.
   *
   * Only fires for a genuine in-place switch. A fresh connect and a disconnect
   * both move `state.status`, and that listener is registered first, so it has
   * already recorded the new address synchronously by the time this runs. The
   * `lastAddress` check below is what makes the two paths mutually exclusive.
   */
  private handleActiveAddressChangeEntryKick(): void {
    // An account switch replaces the connection object; kick a lookup for
    // the new one so events that follow can name the wallet.
    try {
      this.kickWalletConnectPeerLookup(this.getState());
    } catch {
      /* a throwing store must not break the flow */
    }
  }

  private async handleActiveAddressChange(
    address: string | undefined,
    prevAddress: string | undefined
  ): Promise<void> {
    this.handleActiveAddressChangeEntryKick();
    const state = this.getState();
    if (state.status !== "connected") return;

    // Tell an in-place account switch apart from a connector falling away.
    //
    // With more than one entry in `state.connections`, disconnecting the
    // current connector leaves the global status on "connected" and simply
    // moves `state.current` to another live connection. The status listener
    // never sees anything, so if this path ignores it the disconnect is lost.
    //
    // Checked BEFORE the address comparisons below, because two connectors
    // can hold the SAME account - MetaMask and Rabby over one hardware wallet
    // - and then the address does not change at all when one falls away.
    const trackedConnectionId = this.trackingState.lastConnectionId;
    const trackedConnectionGone =
      !!trackedConnectionId && !state.connections.has(trackedConnectionId);

    // A changed active connection is a transition in its own right, even when
    // the address is identical. Two connectors can hold the same account on
    // DIFFERENT chains, and switching between them moves neither the address
    // nor `state.status`; the chain listener also defers because
    // `state.current` no longer matches what is tracked. Left here, the
    // tracked chain stays on the connector the user left and later mutations
    // slip past `excludeChains`.
    const connectionChanged =
      this.trackingState.lastConnectionId !== undefined &&
      state.current !== undefined &&
      state.current !== this.trackingState.lastConnectionId;

    if (!trackedConnectionGone && !connectionChanged) {
      if (!address || address === prevAddress) return;
      // Already handled by the status listener (fresh connect, or the seed).
      // Case-insensitive, like every other address comparison here.
      if (
        this.trackingState.lastAddress?.toLowerCase() === address.toLowerCase()
      ) {
        return;
      }
    }

    // Same account, different connector, both still live: follow the new
    // connection and take its chain. Nothing connected or disconnected, so no
    // connect or disconnect event is owed.
    if (
      connectionChanged &&
      !trackedConnectionGone &&
      address &&
      this.trackingState.lastAddress?.toLowerCase() === address.toLowerCase()
    ) {
      const liveChain = this.getActiveConnectionChainId(state) ?? state.chainId;
      logger.info(
        "WagmiEventHandler: Active connection changed for the same account",
        { address, from: this.trackingState.lastConnectionId, to: state.current }
      );
      this.trackingState.lastConnectionId = state.current;
      if (liveChain !== undefined && liveChain !== this.trackingState.lastChainId) {
        await this.applyChainForTrackedWallet(address, liveChain);
      }
      return;
    }

    if (!address) return;

    // Take the ticket BEFORE anything that can return early. A newer
    // transition has to invalidate the older one even when it cannot finish
    // itself - a connection whose chain has not arrived yet returns below, and
    // if that happened after the increment the older continuation would resume
    // and adopt a connection wagmi had already left.
    const generation = ++this.transitionGeneration;

    // Prefer the chain of the connection that is now current. `state.chainId`
    // is global and can still describe the previous connection - with several
    // connections, or with syncConnectedChain disabled, they diverge.
    const chainId = this.getActiveConnectionChainId(state) ?? state.chainId;
    if (chainId === undefined) return;

    if (trackedConnectionGone) {
      const stillConnected =
        !!prevAddress && this.isAddressConnected(state, prevAddress);

      if (stillConnected) {
        // The connector went away but the ACCOUNT did not: another live
        // connection still holds it. Nothing disconnected from the user's
        // point of view, so no event - just follow the connection.
        logger.info(
          "WagmiEventHandler: Tracked connector fell away, account still connected elsewhere",
          { address: prevAddress, connection: state.current }
        );
        this.trackingState.lastConnectionId = state.current;
        if (
          this.trackingState.lastAddress?.toLowerCase() === address.toLowerCase()
        ) {
          // The two connectors can sit on different chains. The chain callback
          // deferred to this handler because the new connection was not
          // adopted yet, so returning now would leave `lastChainId` on the
          // chain of the connector that just went away - mislabelling later
          // events and letting them past `excludeChains`.
          if (this.trackingState.lastChainId !== chainId) {
            await this.applyChainForTrackedWallet(address, chainId);
          }
          return;
        }
      } else if (prevAddress) {
        logger.info(
          "WagmiEventHandler: Tracked connector disconnected, wagmi fell back to another connection",
          { disconnected: prevAddress, fallback: address }
        );
        const goneChainId = this.trackingState.lastChainId;
        this.releaseTrackedWallet();

        if (this.formo.isAutocaptureEnabled("disconnect") && this.isEmittingOwner) {
          try {
            // Emitted before central state is cleared, so excludeChains can
            // still gate it on the chain the wallet was actually on.
            await this.formo.disconnect({
              chainId: goneChainId,
              address: prevAddress,
            });
          } catch (error) {
            logger.error(
              "WagmiEventHandler: Error tracking connector fallback disconnect:",
              error
            );
          }
        } else {
          this.formo.syncWalletState({ chainId: goneChainId });
        }

        // Wagmi may have moved again while that emission was in flight, or the
        // handler may have been torn down. The newer callback owns the wallet
        // now; resuming here would overwrite it with state captured before the
        // change. Re-read the live store rather than trusting the snapshot:
        // the whole wallet can have disconnected, which advances no
        // transition ticket of its own.
        let liveNow: WagmiState | undefined;
        try {
          liveNow = this.getState();
        } catch {
          /* treated as superseded below */
        }
        const stillCurrent =
          !this.disposed &&
          liveNow?.status === "connected" &&
          liveNow.current === state.current;

        if (generation !== this.transitionGeneration || !stillCurrent) {
          logger.debug(
            "WagmiEventHandler: A newer transition superseded this one, stopping",
            { address }
          );
          // `disconnect()` clears the central wallet namespace as it
          // completes, and it has just done so on top of whatever the newer
          // transition adopted. Private tracking still names the new wallet
          // while central state is empty, which silently drops the address and
          // chain from every later event. Put back what is actually live.
          this.restoreCentralStateFromTracking();
          return;
        }
      }
      // Fall through: the connection wagmi fell back to becomes the tracked
      // wallet below. The page-load marker keeps it from re-announcing a
      // wallet this page load already reported.
    }

    logger.info("WagmiEventHandler: Active account switched", {
      from: prevAddress,
      to: address,
      chainId,
    });

    // Sync central state first so tracking.excludeChains is enforced even when
    // connect autocapture is disabled.
    this.formo.syncWalletState({ chainId, address });

    // Same rule as the seed: while tracking is suppressed, syncWalletState
    // refuses to learn a wallet, and retaining it privately would let the
    // mutation handlers attribute events to an address the SDK declined to
    // know. Compared case-insensitively because the checksummed form is stored.
    if (this.formo.currentAddress?.toLowerCase() !== address.toLowerCase()) {
      logger.debug(
        "WagmiEventHandler: Central state declined the switched account, not adopting",
        { address, chainId }
      );
      // Drop the previous wallet too. The user has moved off it, so leaving it
      // in tracking state would attribute this account's later signatures and
      // transactions to the account they switched away from - worse than
      // recording nothing.
      this.releaseTrackedWallet();
      return;
    }

    this.trackingState.lastAddress = address;
    this.trackingState.lastChainId = chainId;
    this.trackingState.lastConnectionId = state.current;

    // Gated on `willTrackEvent` as well, like the seed and the ordinary
    // connect path. Without it a switch made while tracking was disabled, or
    // onto an excluded chain, marked the new wallet as announced even though
    // `connect()` dropped the event - and the wallet then stayed silent for
    // the rest of the page load once the configuration allowed it.
    if (
      this.formo.isAutocaptureEnabled("connect") &&
      this.isEmittingOwner &&
      this.formo.willTrackEvent(chainId)
    ) {
      // Move the page-load marker onto the wallet that is now active.
      //
      // Gated on ownership as well, like the ordinary connect path. A
      // non-owner that marked here would make the real owner find the marker
      // and stay silent, and the non-owner's own emission dies with its queue
      // when that instance is torn down - losing the connect entirely.
      //
      // Only drop the previous wallet's marker when that wallet is genuinely
      // gone. On an in-place account switch the old account leaves the
      // connection and must be able to announce itself again later. But with
      // several connections the previous wallet is often still connected -
      // it merely stopped being `state.current` - and forgetting it there
      // would make it re-announce every time wagmi switched back.
      if (prevAddress && !this.isAddressConnected(state, prevAddress)) {
        announcedConnections.delete(
          announceKey(this.formo.writeKey, prevAddress)
        );
      }
      const walletKey = announceKey(this.formo.writeKey, address);
      const connection = state.current
        ? state.connections.get(state.current)
        : undefined;
      // The connection object is passed so this marker gets the same
      // indefinite, identity-based validity the seed and connect paths give
      // theirs. Recording only the address-keyed marker meant the expiry
      // timer could clear it while the connection was unchanged, and the next
      // seed would emit a duplicate connect.
      const alreadyAnnounced =
        announcementState(walletKey, connection) !== "none";
      markAnnounced(walletKey, connection);
      if (alreadyAnnounced) {
        // Reached by the connector-fallback path above: wagmi made a
        // connection active that this page load already reported. Becoming
        // active is not a new connect.
        logger.debug(
          "WagmiEventHandler: Fallback connection was already announced, not re-emitting connect",
          { address }
        );
        return;
      }
      try {
        const connectorName = this.getConnectorName(state);
        await this.formo.connect(
          { chainId, address },
          {
            ...(connectorName && { providerName: connectorName }),
          }
        );
      } catch (error) {
        releaseAnnouncement(walletKey, connection);
        logger.error(
          "WagmiEventHandler: Error tracking account switch:",
          error
        );
      }
    }
  }

  /**
   * Record and emit a chain move for the wallet already being tracked.
   *
   * Shared by `handleChainChange()` and the connector-fallback path, which
   * has to apply the chain itself: the chain callback defers while the new
   * connection is not adopted yet, so nothing else would.
   */
  private async applyChainForTrackedWallet(
    address: string,
    chainId: number
  ): Promise<void> {
    // Sync central state unconditionally so a switch to an excluded chain is
    // honored even when chain autocapture is disabled.
    this.formo.syncWalletState({ chainId, address });

    if (this.formo.currentAddress?.toLowerCase() !== address.toLowerCase()) {
      logger.debug(
        "WagmiEventHandler: Central state declined the new chain, dropping the wallet",
        { address, chainId }
      );
      this.releaseTrackedWallet();
      return;
    }

    this.trackingState.lastChainId = chainId;

    if (this.formo.isAutocaptureEnabled("chain") && this.isEmittingOwner) {
      try {
        await this.formo.chain({ chainId, address });
      } catch (error) {
        logger.error("WagmiEventHandler: Error tracking chain change:", error);
      }
    }
  }

  /**
   * Handle chain ID changes
   */
  private async handleChainChange(
    chainId: number | undefined,
    prevChainId: number | undefined
  ): Promise<void> {
    // Keep the fallback-wrapped provider's registry chain in step with the
    // store, so request-derived events are labelled correctly even when the
    // provider exposes no synchronous chainId. Only when the report is
    // about the connection that provider belongs to: after a connector
    // switch the store's chain describes the NEW connection, and writing it
    // to the old provider would mislabel that wallet's events.
    if (this.fallbackProvider !== undefined) {
      const live = this.getState();
      const activeConnector = live.current
        ? live.connections.get(live.current)?.connector
        : undefined;
      if (activeConnector === this.fallbackConnector) {
        try {
          (this.formo as unknown as {
            _rememberWagmiProviderChain?: (p: unknown, c: number | undefined) => void;
          })._rememberWagmiProviderChain?.(this.fallbackProvider, chainId);
        } catch {
          /* never let bookkeeping break the chain flow */
        }
      }
    }

    if (chainId === prevChainId || chainId === undefined) {
      return;
    }

    // Only track chain changes when connected.
    //
    // Remember what was dropped: wagmi reports the chain while still
    // `reconnecting`, and the `connected` transition that follows can be
    // dropped by the processing guard, so nothing else would ever apply it.
    // `reconcileWithLiveState()` replays it once the lock is free.
    const state = this.getState();
    if (state.status !== "connected") {
      this.pendingChainId = chainId;
      return;
    }
    this.pendingChainId = undefined;

    const address = this.getConnectedAddress(state);
    if (!address) {
      logger.warn("WagmiEventHandler: Chain changed but no address found");
      return;
    }

    // Ignore a chain that belongs to a connection this handler has not adopted
    // yet.
    //
    // Both subscriptions fire for one wagmi update and this one can run first.
    // During a connector fallback that would overwrite `lastChainId` with the
    // INCOMING connection's chain, so the outgoing wallet's disconnect - which
    // the connection handler is about to emit - would be labelled with the
    // chain of the wallet that replaced it, and a spurious `chain` event would
    // be emitted for a wallet not yet adopted. The connection handler owns
    // that transition and records the chain itself.
    if (
      this.trackingState.lastConnectionId !== undefined &&
      state.current !== undefined &&
      state.current !== this.trackingState.lastConnectionId
    ) {
      logger.debug(
        "WagmiEventHandler: Chain change belongs to a connection not adopted yet, deferring",
        { chainId, from: this.trackingState.lastConnectionId, to: state.current }
      );
      return;
    }

    // The chain arriving can be what completes a connection the constructor
    // saw only half of. Adopt it now rather than waiting for a status change
    // that an unchanged connection will never produce.
    //
    // Also retries a wallet that IS adopted but was never announced - seeded
    // on an excluded chain, or while tracking was off. Gating this on
    // `!lastAddress` alone meant such a wallet could switch to an allowed
    // chain and get a `chain` event without ever getting its `connect`.
    const hadAddress = !!this.trackingState.lastAddress;
    const wasAnnounced = this.isCurrentWalletAnnounced();
    if (!hadAddress || !wasAnnounced) {
      this.retryAdoption();
      // Suppress the chain event ONLY if the retry actually did something -
      // adopted a connection that was not tracked, or announced one that was
      // not announced. In either case the seed already reported the new chain
      // and falling through would double count it.
      //
      // Crucially this must NOT fire when the retry was a no-op. With
      // `autocapture.connect` disabled nothing is ever announced, so an
      // unconditional return here dropped every chain event for the whole
      // page load.
      // Suppress ONLY when the retry announced a connect, because that
      // connect already carried the new chain. Adoption on its own reports
      // nothing - with `autocapture.connect` disabled it never can - so
      // returning on it swallowed the chain event the app did ask for.
      const announcedNow = !wasAnnounced && this.isCurrentWalletAnnounced();
      if (announcedNow) return;
    }

    logger.info("WagmiEventHandler: Chain changed", {
      chainId,
      prevChainId,
      address,
    });

    await this.applyChainForTrackedWallet(address, chainId);
  }

  /**
   * Set up mutation tracking for signatures and transactions
   */
  private setupMutationTracking(): void {
    if (!this.queryClient) {
      return;
    }

    logger.info("WagmiEventHandler: Setting up mutation tracking");

    const mutationCache = this.queryClient.getMutationCache();
    const unsubscribe = mutationCache.subscribe((event: MutationCacheEvent) => {
      this.handleMutationEvent(event);
    });

    this.unsubscribers.push(unsubscribe);
    logger.info("WagmiEventHandler: Mutation tracking set up successfully");
  }

  /**
   * Set up query tracking for transaction confirmations
   * Listens for waitForTransactionReceipt queries to detect CONFIRMED status
   */
  private setupQueryTracking(): void {
    if (!this.queryClient) {
      return;
    }

    logger.info("WagmiEventHandler: Setting up query tracking");

    const queryCache = this.queryClient.getQueryCache();
    const unsubscribe = queryCache.subscribe((event: QueryCacheEvent) => {
      this.handleQueryEvent(event);
    });

    this.unsubscribers.push(unsubscribe);
    logger.info("WagmiEventHandler: Query tracking set up successfully");
  }

  /**
   * Handle query cache events (transaction confirmations)
   */
  private handleQueryEvent(event: QueryCacheEvent): void {
    if (event.type !== "updated") {
      return;
    }
    // Overlapping handlers share one MutationCache/QueryCache, so without
    // this each of them emits for the same mutation.
    if (!this.isEmittingOwner) {
      return;
    }

    const query = event.query;
    const queryKey = query.queryKey;

    if (!queryKey || queryKey.length === 0) {
      return;
    }

    const queryType = queryKey[0] as string;

    // Only the two query families that settle something we broadcast:
    // waitForTransactionReceipt for single transactions, callsStatus for
    // EIP-5792 batches (both useCallsStatus and useWaitForCallsStatus share
    // the 'callsStatus' key, in wagmi 2 and 3 alike).
    if (queryType !== "waitForTransactionReceipt" && queryType !== "callsStatus") {
      return;
    }

    // Batch settlement dedupes on the pending-batch registry, NOT on
    // processedQueries: settling deletes the registration, so a duplicate
    // delivery finds nothing to do. A processed-key here would be worse
    // than redundant - the status query can complete BEFORE the sendCalls
    // mutation registers the batch (TanStack dispatches a mutation's
    // success state after its onSuccess callbacks, and apps await the
    // status inside onSuccess), and a key recorded on that early skip
    // would block every refetch from ever settling the batch.
    if (queryType === "callsStatus") {
      this.handleCallsStatusQuery(query);
      return;
    }

    const state = query.state;

    // Extract receipt status early to include in deduplication key
    // This ensures CONFIRMED vs REVERTED outcomes are processed separately
    const receipt = state.data as { status?: string } | undefined;
    const receiptStatus = receipt?.status;

    // Create a unique key for this query state to prevent duplicate processing
    // Include receipt status to distinguish between CONFIRMED and REVERTED outcomes
    const queryStateKey = `${query.queryHash}:${state.status}:${receiptStatus || ""}`;

    // Skip if we've already processed this query state
    if (this.processedQueries.has(queryStateKey)) {
      logger.debug("WagmiEventHandler: Skipping duplicate query event", {
        queryType,
        queryHash: query.queryHash,
        status: state.status,
        receiptStatus,
      });
      return;
    }

    // Mark this query state as processed
    this.processedQueries.add(queryStateKey);

    logger.debug("WagmiEventHandler: Query event", {
      queryType,
      queryHash: query.queryHash,
      status: state.status,
    });

    // Handle transaction receipt queries
    this.handleTransactionReceiptQuery(query);

    // Clean up old processed queries to prevent memory leaks
    cleanupOldEntries(this.processedQueries);
  }

  /**
   * Settle a just-registered batch from a status query that already ran.
   *
   * Best-effort by design: the minimal QueryClient interface the SDK
   * accepts is not guaranteed to expose cache lookup, and a missing
   * `getAll` just means settlement waits for the next query event, which
   * is where it normally comes from anyway.
   */
  private settleFromCachedCallsStatus(batchId: string): void {
    try {
      const cache = this.queryClient?.getQueryCache() as unknown as {
        getAll?: () => Array<{ queryKey?: unknown[]; state?: unknown }>;
      };
      const queries = cache?.getAll?.();
      if (!Array.isArray(queries)) return;
      for (const query of queries) {
        const key = query?.queryKey;
        if (
          Array.isArray(key) &&
          key[0] === "callsStatus" &&
          (key[1] as { id?: string } | undefined)?.id === batchId
        ) {
          this.handleCallsStatusQuery(query);
        }
      }
    } catch (error) {
      logger.debug("WagmiEventHandler: cached callsStatus scan failed", error);
    }
  }

  /**
   * Settle an EIP-5792 batch from a `callsStatus` query.
   *
   * Only batches whose broadcast this SDK observed are settled: the batch id
   * must be in `pendingBatches`, for the same reason receipt queries are
   * gated on an observed hash - queries are visible to any code sharing the
   * QueryClient, and emitting for an id we never saw broadcast would let a
   * forged query invent transactions.
   *
   * Outcome semantics are shared with the EIP-1193 path (`src/evm/batch.ts`):
   * per-call receipts outrank the batch verdict, an atomic batch's single
   * receipt reaches every call, and a 600 leaves receipt-less calls
   * unsettled rather than guessed.
   */
  private handleCallsStatusQuery(query: any): void {
    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    const queryKey = query.queryKey;
    // Query key format: ['callsStatus', { id, ... }]
    const params = queryKey[1] as { id?: string } | undefined;
    const batchId = params?.id;
    if (!batchId) {
      return;
    }

    const pending = this.pendingBatches.get(batchId);
    if (!pending) {
      logger.debug("WagmiEventHandler: unobserved batch", { batchId });
      return;
    }

    const state = query.state;
    if (state.status !== "success" || !state.data) {
      return;
    }

    try {
      const res = state.data as BatchStatusResult;
      const code = readBatchStatusCode(res);
      // Below 200 the batch is still pending; the query will update again.
      if (code === undefined || code < 200) {
        return;
      }

      logger.debug("WagmiEventHandler: batch settled", { batchId, code });

      // An explicit mutation chain is authoritative. Otherwise prefer the
      // chain the settlement result names - EIP-5792 v2 reports where the
      // batch actually landed - over one inferred from the connection at
      // broadcast, which goes stale if the wallet moves chains while the
      // prompt is up. Same precedence as the single-transaction receipt
      // path.
      const settledChainId = pending.chainIdWasExplicit
        ? pending.chainId
        : readBatchChainId(res) ?? pending.chainId;

      pending.calls.forEach((call, index) => {
        const receipt = batchReceiptForCall(res, index, pending.calls.length);
        const outcome = batchCallOutcome(code, receipt);
        // 600 means SOME calls reverted, so a call with no receipt of its
        // own has not been decided. Reporting it either way would invent a
        // result; leaving it unsettled is the honest answer.
        if (outcome === undefined) return;
        this.formo.transaction(
          {
            status: outcome,
            chainId: settledChainId || 0,
            address: pending.address,
            ...(call.data && { data: call.data }),
            ...(call.to && { to: call.to }),
            ...(call.value && { value: call.value }),
            ...(receipt?.transactionHash
              ? { transactionHash: receipt.transactionHash }
              : {}),
          },
          {
            batch_size: pending.calls.length,
            batch_index: index,
            batch_id: batchId,
            ...(pending.providerName
              ? { providerName: pending.providerName }
              : {}),
          }
        );
      });

      // Settled; a later refetch of the same query must not re-emit.
      this.pendingBatches.delete(batchId);
    } catch (error) {
      logger.error("WagmiEventHandler: callsStatus error:", error);
    }
  }

  /**
   * Handle waitForTransactionReceipt query completion
   * Emits CONFIRMED or REVERTED transaction status
   */
  private handleTransactionReceiptQuery(query: any): void {
    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    const state = query.state;
    const queryKey = query.queryKey;

    // Only handle successful queries (transaction confirmed on chain)
    if (state.status !== "success") {
      return;
    }

    // Extract hash and chainId from query key
    // Query key format: ['waitForTransactionReceipt', { hash, chainId, ... }]
    const params = queryKey[1] as { hash?: string; chainId?: number } | undefined;
    const transactionHash = params?.hash;
    // Resolved after the pending lookup below, so the broadcast chain wins.
    const queryChainId = params?.chainId;

    if (!transactionHash) {
      logger.warn("WagmiEventHandler: Transaction receipt query but no hash found");
      return;
    }

    // Retrieve stored transaction details from the BROADCASTED event.
    // Normalize hash to lowercase for consistent lookup.
    const normalizedHash = transactionHash.toLowerCase();
    const pendingTx = this.pendingTransactions.get(normalizedHash);

    // Only emit receipt-derived events for a hash we actually observed
    // being broadcast through this handler. The QueryClient is supplied
    // by the host app and its cache can be written by app code or other
    // deps, so without this gate a forged waitForTransactionReceipt
    // entry could fabricate a confirmed/reverted transaction for an
    // arbitrary hash. No pendingTx → not our broadcast → ignore.
    if (!pendingTx) {
      logger.debug(
        "WagmiEventHandler: Receipt for unobserved tx hash; ignoring",
        { transactionHash }
      );
      return;
    }
    const address = pendingTx.address;

    // The chain the transaction was actually broadcast on wins, because the
    // active chain can change between broadcast and receipt and would
    // otherwise relabel the confirmation.
    //
    // Order: a chain the caller named explicitly, then the receipt query's own
    // chain, then the chain we observed at broadcast time, then the current
    // one. The inferred broadcast chain sits below the query's because the
    // query names the chain the receipt was actually read from.
    const chainId = pendingTx.chainIdWasExplicit
      ? pendingTx.chainId
      : queryChainId ?? pendingTx.chainId ?? this.trackingState.lastChainId;

    if (!address) {
      logger.warn("WagmiEventHandler: Transaction receipt query but no address available");
      return;
    }

    try {
      // Extract receipt data
      const receipt = state.data as {
        status?: "success" | "reverted";
        blockNumber?: bigint;
        gasUsed?: bigint;
      } | undefined;

      // Only act on an explicit on-chain outcome. A missing/unknown
      // status must NOT be treated as a confirmation.
      if (receipt?.status !== "success" && receipt?.status !== "reverted") {
        logger.debug(
          "WagmiEventHandler: Receipt without explicit success/reverted status; ignoring",
          { transactionHash, status: receipt?.status }
        );
        return;
      }

      const txStatus = receipt.status === "reverted"
        ? TransactionStatus.REVERTED
        : TransactionStatus.CONFIRMED;

      logger.info("WagmiEventHandler: Tracking transaction confirmation", {
        status: txStatus,
        transactionHash,
        address,
        chainId,
        blockNumber: receipt?.blockNumber?.toString(),
      });

      this.formo.transaction(
        {
          status: txStatus,
          chainId: chainId || 0,
          address,
          transactionHash,
          // Include stored transaction details if available
          ...(pendingTx?.data && { data: pendingTx.data }),
          ...(pendingTx?.to && { to: pendingTx.to }),
          ...(pendingTx?.value && { value: pendingTx.value }),
          ...(pendingTx?.function_name && { function_name: pendingTx.function_name }),
          ...(pendingTx?.function_args && { function_args: pendingTx.function_args }),
        },
        // Spread function args as additional properties (only colliding keys are prefixed)
        {
          ...(pendingTx?.providerName
            ? { providerName: pendingTx.providerName }
            : this.mutationAttribution()),
          ...pendingTx?.safeFunctionArgs,
        }
      );

      // Clean up the pending transaction after confirmation
      this.pendingTransactions.delete(normalizedHash);
    } catch (error) {
      logger.error("WagmiEventHandler: Error handling transaction receipt query:", error);
    }
  }

  /**
   * Handle mutation cache events (signatures, transactions)
   */
  private handleMutationEvent(event: MutationCacheEvent): void {
    if (event.type !== "updated") {
      return;
    }
    // Overlapping handlers share one MutationCache/QueryCache, so without
    // this each of them emits for the same mutation.
    if (!this.isEmittingOwner) {
      return;
    }

    const mutation = event.mutation;
    const mutationKey = mutation.options.mutationKey;
    
    if (!mutationKey || mutationKey.length === 0) {
      return;
    }

    const mutationType = mutationKey[0] as string;
    const state = mutation.state;
    
    // Create a unique key for this mutation state to prevent duplicate processing
    const mutationStateKey = `${mutation.mutationId}:${state.status}`;
    
    // Skip if we've already processed this mutation state
    if (this.processedMutations.has(mutationStateKey)) {
      logger.debug("WagmiEventHandler: Skipping duplicate mutation event", {
        mutationType,
        mutationId: mutation.mutationId,
        status: state.status,
      });
      return;
    }
    
    // Mark this mutation state as processed
    this.processedMutations.add(mutationStateKey);

    logger.debug("WagmiEventHandler: Mutation event", {
      mutationType,
      mutationId: mutation.mutationId,
      status: state.status,
    });

    // Handle signature mutations
    if (mutationType === "signMessage" || mutationType === "signTypedData") {
      this.handleSignatureMutation(mutationType as WagmiMutationKey, mutation);
    }

    // Handle transaction mutations
    if (mutationType === "sendTransaction" || mutationType === "writeContract") {
      this.handleTransactionMutation(mutationType as WagmiMutationKey, mutation);
    }

    // Handle EIP-5792 batch mutations (useSendCalls). Absent this branch,
    // wagmi-mode apps captured nothing for a batch: the EIP-1193 request
    // wrapper that handles `wallet_sendCalls` is never installed in wagmi
    // mode, so the mutation was the only place the batch was visible at all.
    if (mutationType === "sendCalls") {
      this.handleSendCallsMutation(mutation);
    }

    // Clean up old processed mutations to prevent memory leaks
    cleanupOldEntries(this.processedMutations);
  }

  /**
   * Handle signature mutations (signMessage, signTypedData)
   */
  /**
   * Is a PENDING wagmi mutation already covering this wallet request?
   *
   * The hybrid-capture dedup. TanStack dispatches `pending` BEFORE the
   * mutationFn issues the wallet call (verified against query-core), so a
   * hook-driven request always finds its mutation here and the request
   * wrapper stands down; an imperative viem call never does, and the
   * wrapper captures it. Matching is by mutation type, refined with cheap
   * parameter checks where the shapes allow, and errs toward NOT skipping:
   * a duplicate is visible and diagnosable, a silent loss is neither.
   */
  public hasMatchingPendingMutation(method: string, params: unknown[]): boolean {
    try {
      const cache = this.queryClient?.getMutationCache() as unknown as {
        getAll?: () => Array<{
          state?: { status?: string; variables?: Record<string, unknown> };
          options?: { mutationKey?: unknown[] };
        }>;
      };
      const mutations = cache?.getAll?.();
      if (!Array.isArray(mutations)) return false;

      const wanted: Record<string, string[]> = {
        personal_sign: ["signMessage"],
        eth_signTypedData_v4: ["signTypedData"],
        eth_sendTransaction: ["sendTransaction", "writeContract"],
        wallet_sendCalls: ["sendCalls"],
      };
      const types = wanted[method];
      if (!types) return false;

      for (const mutation of mutations) {
        if (mutation?.state?.status !== "pending") continue;
        const key = mutation?.options?.mutationKey?.[0];
        if (typeof key !== "string" || !types.includes(key)) continue;

        // Cheap refinements. On mismatch keep scanning; on no basis to
        // compare, treat the type-level match as decisive.
        const variables = mutation.state?.variables;
        if (key === "sendTransaction" && variables) {
          const req = (Array.isArray(params) ? params[0] : undefined) as
            | { to?: string }
            | undefined;
          const mutTo = (variables as { to?: string }).to;
          if (
            typeof req?.to === "string" &&
            typeof mutTo === "string" &&
            req.to.toLowerCase() !== mutTo.toLowerCase()
          ) {
            continue;
          }
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Wallet attribution for mutation- and query-derived events.
   *
   * Mid-session events (signatures, transactions) fire after the peer
   * lookup has resolved, so a WalletConnect connector names its actual
   * signer here - the first observable consumer of the peer cache.
   */
  private mutationAttribution(): { providerName: string } | undefined {
    try {
      const name = this.getConnectorName(this.getState());
      return name ? { providerName: name } : undefined;
    } catch {
      return undefined;
    }
  }

  private handleSignatureMutation(
    mutationType: WagmiMutationKey,
    mutation: any
  ): void {
    if (!this.formo.isAutocaptureEnabled("signature")) {
      return;
    }

    const state = mutation.state;
    const variables = state.variables || {};
    // An explicit per-call `account` wins over the active connection. wagmi
    // lets a caller sign with an account other than the current one, and the
    // tracked connection describes a different wallet in that case.
    //
    // For typed data the signed chain lives in the EIP-712 domain, not at the
    // top level: `signTypedData` takes `{ domain, types, primaryType, message }`
    // and the domain's `chainId` is what the signature is actually bound to.
    // Reading only `variables.chainId` labelled such a signature with the
    // wallet's current chain, which can be a different one entirely.
    // Falls back to 0 - "could not resolve" - rather than undefined. A caller
    // can name an account before any connection chain is known, and an
    // undefined chain slipped past the exclusion gate, which only refuses an
    // explicit 0. A chain-scoped event whose chain is unknown must fail
    // closed like every other.
    const chainId =
      normalizeChainId(variables.domain?.chainId) ??
      normalizeChainId(variables.chainId) ??
      this.trackingState.lastChainId ??
      0;
    const address =
      resolveAccountAddress(variables.account) || this.trackingState.lastAddress;

    if (!address) {
      logger.warn("WagmiEventHandler: Signature event but no address available");
      return;
    }

    try {
      // Map Wagmi mutation status to Formo signature status.
      let status: SignatureStatus;

      if (state.status === "pending") {
        status = SignatureStatus.REQUESTED;
      } else if (state.status === "success") {
        status = SignatureStatus.CONFIRMED;
      } else if (state.status === "error") {
        status = SignatureStatus.REJECTED;
      } else {
        return; // Ignore idle state
      }

      let message: string;
      if (mutationType === "signMessage") {
        message = variables.message || "";
      } else {
        message = JSON.stringify(variables.message || variables.types || {});
      }

      logger.info("WagmiEventHandler: Tracking signature event", {
        status,
        mutationType,
        address,
        chainId,
      });

      this.formo.signature(
        {
          status,
          chainId,
          address,
          message,
        },
        this.mutationAttribution()
      );
    } catch (error) {
      logger.error("WagmiEventHandler: Error handling signature mutation:", error);
    }
  }

  /**
   * Handle transaction mutations (sendTransaction, writeContract)
   */
  private handleTransactionMutation(
    mutationType: WagmiMutationKey,
    mutation: any
  ): void {
    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    const state = mutation.state;
    const variables = state.variables || {};
    // Explicit per-call values win over the active connection. wagmi lets a
    // caller target another account or chain, and the tracked connection
    // describes a different wallet in that case. Fall back to the connection
    // for the usual call that omits them.
    //
    // For sendTransaction the user's address is `from`; for writeContract
    // `variables.address` is the contract, not the user.
    // Distinguish an explicitly requested chain from one merely inferred from
    // the active connection: only the former is authoritative for the receipt.
    // Normalized: viem accepts a hex string or a bigint for `chainId`, and a
    // non-number here would both land in the payload and defeat the numeric
    // `tracking.excludeChains` comparison.
    const explicitChainId = normalizeChainId(variables.chainId);
    // Left undefined on purpose. The emission below already coerces with
    // `chainId || 0`, and defaulting here instead would write 0 into the
    // pending-transaction record, where an absent chain is what lets the
    // receipt query's chain win for the confirmation.
    const chainId = explicitChainId ?? this.trackingState.lastChainId;
    const accountAddress = resolveAccountAddress(variables.account);
    const userAddress =
      accountAddress || variables.from || this.trackingState.lastAddress;

    if (!userAddress) {
      logger.warn(
        "WagmiEventHandler: Transaction event but no address available"
      );
      return;
    }

    try {
      // Map Wagmi mutation status to Formo transaction status
      let status: TransactionStatus;
      let transactionHash: string | undefined;

      if (state.status === "pending") {
        status = TransactionStatus.STARTED;
      } else if (state.status === "success") {
        status = TransactionStatus.BROADCASTED;
        transactionHash = state.data as string;
      } else if (state.status === "error") {
        status = TransactionStatus.REJECTED;
      } else {
        return; // Ignore idle state
      }

      // Extract transaction details based on mutation type
      let data: string | undefined;
      let to: string | undefined;
      let function_name: string | undefined;
      let function_args: Record<string, unknown> | undefined;
      const value = variables.value?.toString();

      if (mutationType === "writeContract") {
        // For writeContract, extract function info and encode data
        const { abi, functionName: fnName, args, address: contractAddress, dataSuffix } = variables;
        to = contractAddress;
        function_name = fnName;

        if (abi && fnName) {
          // Extract function arguments as a name-value map
          function_args = extractFunctionArgs(abi, fnName, args);

          // Encode the function data synchronously if viem is available
          const encodedData = encodeWriteContractData(abi, fnName, args);
          if (encodedData) {
            // Include dataSuffix (e.g. ERC-8021 builder code) so full calldata is sent to server
            data = concatCalldataWithSuffix(encodedData, dataSuffix);
            logger.debug(
              "WagmiEventHandler: Encoded writeContract data",
              data.substring(0, 10)
            );
          }
        }
      } else {
        // For sendTransaction, use variables directly
        // Only data is available, function_name and function_args are not sent
        data = variables.data;
        to = variables.to;
      }

      logger.info("WagmiEventHandler: Tracking transaction event", {
        status,
        mutationType,
        address: userAddress,
        chainId,
        transactionHash,
        function_name,
      });

      // Build safeFunctionArgs with collision handling and struct flattening
      const safeFunctionArgs = buildSafeFunctionArgs(function_args, RESERVED_FIELDS);

      // Store transaction details for BROADCASTED status to use in CONFIRMED/REVERTED
      // Normalize hash to lowercase for consistent lookup
      // Include the sender address to handle wallet switches between broadcast and confirmation
      if (status === TransactionStatus.BROADCASTED && transactionHash) {
        const normalizedHash = transactionHash.toLowerCase();
        const txDetails = {
          address: userAddress,
          ...(this.mutationAttribution() ?? {}),
          // Record the chain this was broadcast on either way, and remember
          // whether the caller named it. The common `sendTransaction({ to })`
          // has no explicit chain, so storing nothing meant a network switch
          // between broadcast and receipt relabelled the confirmation with the
          // chain the user had moved to.
          ...(chainId !== undefined && { chainId }),
          chainIdWasExplicit: explicitChainId !== undefined,
          ...(data && { data }),
          ...(to && { to }),
          ...(value && { value }),
          ...(function_name && { function_name }),
          ...(function_args && { function_args }),
          ...(safeFunctionArgs && { safeFunctionArgs }),
        };
        this.pendingTransactions.set(normalizedHash, txDetails);

        logger.debug("WagmiEventHandler: Stored pending transaction for confirmation", {
          transactionHash: normalizedHash,
        });

        // Clean up old pending transactions to prevent memory leaks (keep max 100)
        // Remove oldest 50 entries when limit exceeded to handle high-throughput scenarios
        if (this.pendingTransactions.size > 100) {
          const keys = Array.from(this.pendingTransactions.keys());
          for (let i = 0; i < 50 && i < keys.length; i++) {
            this.pendingTransactions.delete(keys[i]);
          }
        }
      }

      this.formo.transaction(
        {
          status,
          chainId: chainId || 0,
          address: userAddress,
          ...(data && { data }),
          ...(to && { to }),
          ...(value && { value }),
          ...(transactionHash && { transactionHash }),
          ...(function_name && { function_name }),
          ...(function_args && { function_args }),
        },
        // Spread function args as additional properties (only colliding keys are prefixed)
        { ...this.mutationAttribution(), ...safeFunctionArgs }
      );
    } catch (error) {
      logger.error(
        "WagmiEventHandler: Error handling transaction mutation:",
        error
      );
    }
  }

  /**
   * One `transaction` event per call in an EIP-5792 batch, wagmi path.
   *
   * Mirrors `EvmRequestTracker.trackBatchedCalls` exactly: the CALL is the
   * unit of attribution, so each call gets its own STARTED at pending and
   * BROADCASTED (with `batch_id`) when the wallet returns an id. The batch's
   * on-chain outcome arrives through the `callsStatus` query, handled in
   * `handleCallsStatusQuery`.
   *
   * Rejection matches the 1193 path's rule: only a user rejection (4001
   * anywhere in the error chain) marks the calls rejected - one dismissal
   * dismisses the whole prompt, so every call in it is rejected, and
   * reporting only the first would undercount. Any other error (a wallet
   * without EIP-5792 support, a transport failure) emits nothing further:
   * inventing a rejection the user never made would be worse.
   */
  private handleSendCallsMutation(mutation: any): void {
    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    const state = mutation.state;
    const variables = state.variables || {};
    const rawCalls = Array.isArray(variables.calls) ? variables.calls : [];
    if (rawCalls.length === 0) {
      return;
    }

    // Same resolution order as single transactions: an explicit per-call
    // value beats the tracked connection.
    const explicitChainId = normalizeChainId(variables.chainId);
    const chainId = explicitChainId ?? this.trackingState.lastChainId;
    const accountAddress = resolveAccountAddress(variables.account);
    const userAddress = accountAddress || this.trackingState.lastAddress;

    if (!userAddress) {
      logger.warn("WagmiEventHandler: sendCalls without address");
      return;
    }

    try {
      const calls = rawCalls.map(
        (call: { to?: string; value?: unknown; data?: string }) => ({
          to: call?.to,
          value: call?.value !== undefined ? String(call.value) : undefined,
          data: call?.data,
        })
      );

      const attribution = this.mutationAttribution();
      const emitAll = (
        status: TransactionStatus,
        extra?: Record<string, unknown>
      ) => {
        calls.forEach(
          (
            call: { to?: string; value?: string; data?: string },
            index: number
          ) => {
            this.formo.transaction(
              {
                status,
                chainId: chainId || 0,
                address: userAddress,
                ...(call.data && { data: call.data }),
                ...(call.to && { to: call.to }),
                ...(call.value && { value: call.value }),
              },
              {
                batch_size: calls.length,
                batch_index: index,
                ...attribution,
                ...extra,
              }
            );
          }
        );
      };

      if (state.status === "pending") {
        // STARTED carries no batch id, exactly as a single transaction has
        // no hash yet: the wallet has not issued one.
        logger.debug("WagmiEventHandler: sendCalls start", { calls: calls.length });
        emitAll(TransactionStatus.STARTED);
      } else if (state.status === "success") {
        const batchId = readBatchId(state.data);
        logger.debug("WagmiEventHandler: sendCalls broadcast", { batchId });
        emitAll(
          TransactionStatus.BROADCASTED,
          batchId ? { batch_id: batchId } : undefined
        );
        if (batchId) {
          this.pendingBatches.set(batchId, {
            address: userAddress,
            ...(attribution ?? {}),
            ...(chainId !== undefined && { chainId }),
            chainIdWasExplicit: explicitChainId !== undefined,
            calls,
          });
          // Same bound as pendingTransactions, same reason.
          if (this.pendingBatches.size > 100) {
            const keys = Array.from(this.pendingBatches.keys());
            for (let i = 0; i < 50 && i < keys.length; i++) {
              this.pendingBatches.delete(keys[i]);
            }
          }
          // The status query can have completed BEFORE this registration:
          // TanStack dispatches a mutation's success state after its
          // onSuccess callbacks, and apps await waitForCallsStatus inside
          // onSuccess. That early query event found no registration and did
          // nothing, so look for its settled result in the cache now.
          this.settleFromCachedCallsStatus(batchId);
        }
      } else if (state.status === "error") {
        if (isUserRejection(state.error)) {
          logger.debug("WagmiEventHandler: sendCalls rejected");
          emitAll(TransactionStatus.REJECTED);
        }
      }
    } catch (error) {
      logger.error("WagmiEventHandler: sendCalls error:", error);
    }
  }

  /**
   * Get the current Wagmi state
   * Supports both getState() method and direct state property access
   * for compatibility with different Wagmi wrappers (RainbowKit, etc.)
   */
  private getState(): WagmiState {
    // Try getState() method first (standard Wagmi API)
    if (typeof this.wagmiConfig.getState === "function") {
      return this.wagmiConfig.getState();
    }

    // Fall back to direct state property (RainbowKit and some Wagmi setups)
    if (this.wagmiConfig.state) {
      return this.wagmiConfig.state;
    }

    // Return a default disconnected state if neither is available
    logger.warn(
      "WagmiEventHandler: Unable to get state from config, returning default state"
    );
    return {
      status: "disconnected",
      connections: new Map(),
      current: undefined,
      chainId: undefined,
    };
  }

  /**
   * Chain of the connection that is currently active.
   *
   * Authoritative, because `state.chainId` is a single global value. With
   * `syncConnectedChain: false` it stays on the chain the APP selected while
   * the connection reports the chain the WALLET is actually on, so seeding
   * from the global could label a wallet on an excluded chain as an allowed
   * one and send events the exclusion forbids.
   */
  private getActiveConnectionChainId(state: WagmiState): number | undefined {
    if (!state.current) return undefined;
    return state.connections.get(state.current)?.chainId;
  }

  /**
   * Get the currently connected address from Wagmi state
   */
  private getConnectedAddress(state: WagmiState): string | undefined {
    if (!state.current) {
      return undefined;
    }

    const connection = state.connections.get(state.current);
    if (!connection || connection.accounts.length === 0) {
      return undefined;
    }

    return connection.accounts[0];
  }

  /**
   * Whether any live connection still holds this address.
   *
   * Distinguishes "the user switched away from this account" (gone from every
   * connection) from "this account merely stopped being the current one"
   * (still connected through its own connector).
   */
  private isAddressConnected(state: WagmiState, address: string): boolean {
    const wanted = address.toLowerCase();
    let found = false;
    state.connections.forEach((connection) => {
      if (
        !found &&
        connection.accounts.some((a: string) => a.toLowerCase() === wanted)
      ) {
        found = true;
      }
    });
    return found;
  }


  /**
   * The active connector's name and rdns, for the fallback-wrapped
   * provider's request-derived events.
   *
   * The NAME is exactly what the hook path emits (`getConnectorName`: the
   * live WalletConnect peer for a WalletConnect connector, the connector's
   * own name otherwise), so a branded connector keeps its name on both
   * paths and a session that changes wallets renames on both. The rdns is
   * the connector's when wagmi knows it as ONE value (EIP-6963 discovered
   * connectors carry theirs); a connector that matches several rdns values
   * does not say which one this provider is, so nothing is passed and the
   * registry keeps the sniffed one.
   */
  private connectorAttribution(
    state: WagmiState
  ): { name: string; rdns?: string } | undefined {
    const name = this.getConnectorName(state);
    if (!name) {
      return undefined;
    }
    const raw: unknown = state.current
      ? state.connections.get(state.current)?.connector?.rdns
      : undefined;
    const rdns = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    return { name, ...(rdns && { rdns }) };
  }

  /**
   * Resolver handed to the registry at wrap time, read at each request
   * start, so a request issued right after a connector switch (before the
   * asynchronous re-wrap settles) already carries the new connector.
   */
  private liveConnectorAttribution = ():
    | { name: string; rdns?: string }
    | undefined => {
    if (this.disposed) return undefined;
    try {
      return this.connectorAttribution(this.getState());
    } catch {
      return undefined;
    }
  };

  /**
   * Get the connector name from Wagmi state
   */
  private getConnectorName(state: WagmiState): string | undefined {
    if (!state.current) {
      return undefined;
    }

    const connection = state.connections.get(state.current);
    const connector = connection?.connector as
      | { name?: string; getProvider?: () => Promise<unknown> }
      | undefined;
    if (!connection || !connector) {
      return undefined;
    }

    const cached = walletConnectPeerNames.get(connector as object);
    if (cached) {
      return cached;
    }

    // Backstop kick; the flow entry points kick earlier so the lookup has
    // usually resolved by the time an emission reads the name.
    this.kickWalletConnectPeerLookup(state);

    return connector.name;
  }

  /**
   * Start resolving the wallet behind a WalletConnect connection.
   *
   * Fire-and-forget on purpose: emission paths are synchronous by design
   * and must never wait (see the connect marker comment). Called at the
   * START of the status/address flows rather than only at read time - the
   * lookup is one microtask for an initialised connector, and the emission
   * sits behind several awaits, so kicking early usually means even the
   * FIRST connect names the real wallet. When the race is lost the event
   * honestly says "WalletConnect" and every later event names the peer.
   */
  /**
   * Install the request wrapper on the active connector's provider.
   *
   * This is what lets wagmi mode capture IMPERATIVE viem calls
   * (walletClient.sendTransaction / .signMessage / .writeContract / raw
   * request), which create no mutation and were silently lost. Hook-driven
   * calls stay owned by the mutation handlers via the pending-mutation
   * dedup. Fire-and-forget per connection; a provider that cannot be
   * produced simply keeps mutation-only capture.
   */
  /**
   * Connections THIS instance has wrapped. Deliberately per-instance, not
   * module-level: a module-level guard let a rebuilt SDK instance skip
   * re-wrapping, so ownership stayed with the torn-down instance and every
   * capture died in its closed queue - and it also stopped a second
   * write-key instance from ever registering. Re-wrapping is safe and
   * cheap: the request tracker rebinds ownership of an intact wrapper.
   */
  /**
   * Latest wrap attempt per connector. Every kick re-resolves
   * getProvider() - a connector can hand out a REPLACEMENT provider after
   * a reconnect, so a once-only guard would leave the new session's
   * provider unwrapped forever. Re-wrapping is idempotent: the request
   * tracker rebinds ownership of an intact wrapper. The epoch lets a slow
   * resolution from a superseded kick (an earlier session, an earlier
   * chain) be discarded instead of overwriting fresher state.
   */
  private wrapEpochs = new WeakMap<object, number>();

  /** Consecutive automatic wrap retries per connector; see below. */
  private wrapRetryCounts = new WeakMap<object, number>();

  /** Pending retry timers, cancelled by cleanup(). */
  private wrapRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Bumped on every observed disconnect. Every wrap attempt captures it
   * at kick time and its resolution stands down on a mismatch, so a
   * disconnect invalidates ALL pending wraps at once - including ones
   * whose getProvider() had not resolved yet, which no per-connector
   * bookkeeping can reach because nothing has been recorded for them.
   */
  private wrapSessionGeneration = 0;

  /** The active connector this instance wrapped, and its provider, for
   * chain updates. Kept as a pair so a chain report is only ever applied
   * to the provider of the connector it describes. Keyed by connector,
   * not by connection record: wagmi REPLACES the connection object on
   * every account or chain update, so record identity is not stable. */
  private fallbackConnector?: object;
  private fallbackProvider?: unknown;

  private wrapActiveConnectorProvider(state: WagmiState, isRetry = false): void {
    // OPT-IN only. Wagmi mode's baseline never touches the signing
    // transport; instrumenting the provider is an explicit integrator
    // decision (options.wagmi.eip1193Fallback), made auditable in
    // configuration rather than implied by a version bump.
    const optedIn =
      (this.formo as unknown as {
        options?: { wagmi?: { eip1193Fallback?: boolean } };
      }).options?.wagmi?.eip1193Fallback === true;
    if (!optedIn) {
      return;
    }
    if (state.status !== "connected") {
      // Status kicks run for every transition; only a connected snapshot
      // describes a session worth wrapping.
      return;
    }
    const connection = state.current
      ? state.connections.get(state.current)
      : undefined;
    const connector = connection?.connector as
      | { getProvider?: () => Promise<unknown> }
      | undefined;
    if (!connection || typeof connector?.getProvider !== "function") {
      return;
    }
    const epoch = (this.wrapEpochs.get(connector as object) ?? 0) + 1;
    this.wrapEpochs.set(connector as object, epoch);
    const session = this.wrapSessionGeneration;
    // A store-driven kick resets the retry budget; automatic retries
    // (below) spend it.
    if (!isRetry) {
      this.wrapRetryCounts.delete(connector as object);
    }
    // When the NEWEST attempt fails, older in-flight resolutions have
    // been epoch-discarded (they may describe an earlier session) and
    // nothing else would wrap the provider until the next store update.
    // Recover by re-kicking fresh with live state, bounded so a
    // persistently failing connector cannot loop: after the budget is
    // spent, recovery waits for a real store update, which resets it.
    const retryAfterFailure = () => {
      if (this.disposed) return;
      if (this.wrapEpochs.get(connector as object) !== epoch) {
        // Superseded: the newer attempt owns recovery.
        return;
      }
      const failures = (this.wrapRetryCounts.get(connector as object) ?? 0) + 1;
      this.wrapRetryCounts.set(connector as object, failures);
      if (failures > 3) return;
      const timer = setTimeout(() => {
        this.wrapRetryTimers.delete(timer);
        if (this.disposed) return;
        // Re-kick only while THIS connector is still the active one and
        // no newer attempt superseded this one. A retry for a connector
        // the user has left must not fire at the current connector: with
        // the retry flag it would skip the budget reset and, worse, its
        // fresh epoch would discard the current connector's own in-flight
        // resolution.
        const live = this.getState();
        const stillCurrent =
          live.current !== undefined &&
          live.connections.get(live.current)?.connector === connector;
        if (stillCurrent && this.wrapEpochs.get(connector as object) === epoch) {
          this.wrapActiveConnectorProvider(live, true);
        }
      }, 25 * failures);
      this.wrapRetryTimers.add(timer);
    };
    let resolution: Promise<unknown>;
    try {
      resolution = connector.getProvider();
    } catch {
      // A synchronous throw must not escape into the subscription
      // callback: address-change handling runs after this kick and a
      // propagated throw would silently skip it.
      retryAfterFailure();
      return;
    }
    resolution
      .then((provider) => {
        if (this.wrapEpochs.get(connector as object) !== epoch) {
          // A newer kick is in flight or already resolved; this answer may
          // describe an earlier session. Let the newest one win.
          return;
        }
        // The fallback installs only the request wrapper, so a provider
        // without a synchronous chainId property would never teach the
        // registry its chain and its events would carry chain 0. The wagmi
        // store knows; feed it here and on every later chain change. Read
        // the chain from LIVE state, not from a snapshot taken before this
        // asynchronous resolution: a switch that lands while getProvider is
        // in flight fires handleChainChange before fallbackProvider exists,
        // so a pre-resolution snapshot would stick as the recorded chain.
        // Activity is judged by CONNECTOR identity: wagmi replaces the
        // connection record itself on every account or chain update.
        const live = this.getState();
        // A wrap only describes a CONNECTED session. Status changes kick
        // this path for every transition, and a resolution landing while
        // disconnected would re-point the fallback pair at a provider
        // whose session is over.
        const stillActive =
          !this.disposed &&
          this.wrapSessionGeneration === session &&
          live.status === "connected" &&
          live.current !== undefined &&
          live.connections.get(live.current)?.connector === connector;
        if (!stillActive) {
          // The user moved on while getProvider was in flight. Wrapping
          // now would instrument a provider whose chain nobody feeds -
          // its requests would report chain 0. Switching back re-kicks.
          return;
        }
        const chainId = this.getActiveConnectionChainId(live) ?? live.chainId;
        const wrapped = (this.formo as unknown as {
          _wrapWagmiProvider?: (
            p: unknown,
            chainId?: number,
            attribution?: () => { name: string; rdns?: string } | undefined
          ) => boolean;
        })._wrapWagmiProvider?.(
          provider,
          typeof chainId === "number" ? chainId : undefined,
          this.liveConnectorAttribution
        );
        if (wrapped !== true) {
          // The provider was refused (invalid shape, frozen provider,
          // torn-down SDK).
          retryAfterFailure();
          return;
        }
        this.wrapRetryCounts.delete(connector as object);
        this.fallbackConnector = connector as object;
        this.fallbackProvider = provider;
      })
      .catch(() => {
        // Mutation-only capture remains.
        retryAfterFailure();
      });
  }

  private kickWalletConnectPeerLookup(state: WagmiState): void {
    const connection = state.current
      ? state.connections.get(state.current)
      : undefined;
    const connector = connection?.connector as
      | { name?: string; getProvider?: () => Promise<unknown> }
      | undefined;
    if (
      !connection ||
      !connector ||
      typeof connector.name !== "string" ||
      !/walletconnect/i.test(connector.name) ||
      typeof connector.getProvider !== "function" ||
      walletConnectPeerLookups.has(connection as object)
    ) {
      return;
    }
    walletConnectPeerLookups.add(connection as object);
    // A NEW connection invalidates the cached name SYNCHRONOUSLY. The
    // connect flow reads the cache in the same tick it kicks the lookup,
    // so retaining the previous session's name here deterministically
    // attributed a reconnect-to-a-different-wallet to the OLD wallet.
    // Wrong is worse than generic: the new session's connect now says
    // "WalletConnect" and the resolved peer serves the session's LATER
    // events (signatures, transactions - the attribution work) instead.
    // A rebuild over the SAME connection does not re-kick (guard above),
    // so it keeps its already-proven name.
    if (walletConnectPeerLatest.get(connector as object) !== connection) {
      walletConnectPeerNames.delete(connector as object);
    }
    walletConnectPeerLatest.set(connector as object, connection as object);
    let settled = false;
    // A cached name from a PREVIOUS session is unproven for this one. It
    // keeps serving only until this session's lookup settles or the grace
    // timer fires - whichever ends the uncertainty first - so a hung
    // lookup cannot leave the old wallet's name attached indefinitely.
    const staleTimer = setTimeout(() => {
      if (
        !settled &&
        walletConnectPeerLatest.get(connector as object) === connection
      ) {
        walletConnectPeerNames.delete(connector as object);
      }
    }, 3000);
    (staleTimer as unknown as { unref?: () => void }).unref?.();
    connector
      .getProvider()
      .then((provider) => {
        settled = true;
        clearTimeout(staleTimer);
        // Only the NEWEST session's lookup may write. A previous session's
        // slow resolution landing late would otherwise overwrite the
        // current wallet's name with the old one.
        if (walletConnectPeerLatest.get(connector as object) !== connection) {
          return;
        }
        const peer = readWalletConnectPeer(provider as never);
        if (peer?.name) {
          walletConnectPeerNames.set(connector as object, peer.name);
          logger.debug("WagmiEventHandler: WalletConnect peer resolved", {
            peer: peer.name,
          });
        } else {
          // Resolved WITHOUT peer metadata: the previous wallet's name is
          // disproven for this session, not merely unproven. Drop it, and
          // let a later event retry the lookup - the session may simply
          // not have populated its peer yet.
          walletConnectPeerNames.delete(connector as object);
          walletConnectPeerLookups.delete(connection as object);
        }
      })
      .catch(() => {
        settled = true;
        clearTimeout(staleTimer);
        // The new session could not be inspected, so the PREVIOUS wallet's
        // name must not keep serving: drop it and fall back to the
        // connector's own name until a later session resolves. Guarded so
        // an old session's late failure cannot clear a newer resolution.
        if (walletConnectPeerLatest.get(connector as object) === connection) {
          walletConnectPeerNames.delete(connector as object);
        }
        // A failed lookup must not permanently disqualify the connection:
        // the connector may just have been initialising. A later event
        // retries.
        walletConnectPeerLookups.delete(connection as object);
      });
  }

  /**
   * Clean up all subscriptions
   */
  public cleanup(): void {
    this.wrapRetryTimers.forEach((t) => clearTimeout(t));
    this.wrapRetryTimers.clear();
    logger.debug("WagmiEventHandler: Cleaning up subscriptions");

    if (!this.disposed) {
      this.disposed = true;
      // Nothing in flight may complete against a torn-down handler.
      this.transitionGeneration += 1;
      // Give up the right to emit. Any other live handler for this
      // destination claims it the next time it needs to emit.
      if (this.ownerKey && emittingOwners.get(this.ownerKey) === this) {
        emittingOwners.delete(this.ownerKey);
      }
      // Start the grace period. If nothing re-mounts, the markers are dropped
      // so a reconnect that happens while unobserved still emits.
      const wasLastForDestination = releaseMarkers(this.formo.writeKey);
      // Drop the shared broadcast records rather than leak them - but only
      // after the same grace period the markers get. The ordinary rebuild is
      // cleanup THEN remount, so deleting immediately would lose the receipt
      // for a transaction broadcast moments before teardown.
      if (wasLastForDestination && this.ownerKey) {
        schedulePendingTransactionExpiry(this.ownerKey);
      }
    }

    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.error("WagmiEventHandler: Error during cleanup:", error);
      }
    }
    
    this.unsubscribers = [];
    this.processedMutations.clear();
    this.processedQueries.clear();
    // Deliberately NOT clearing `pendingTransactions`: it is shared per
    // destination, and a replacement handler needs the broadcast records to
    // match incoming receipts against. It is dropped when the last handler
    // for the destination goes away (see below).
    logger.debug("WagmiEventHandler: Cleanup complete");
  }
}

