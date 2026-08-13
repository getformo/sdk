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
 * Wallet already adopted by a seed during this page load, lowercased.
 *
 * Deliberately module scoped rather than per handler or per FormoAnalytics
 * instance. The duplicate this prevents comes from the SDK instance itself
 * being rebuilt - a provider remount, an options change, HMR - while the
 * wallet never disconnected, and per-instance state cannot see that.
 *
 * A real disconnect clears it, so a genuine reconnect within the same page
 * load still emits. A new page load starts with a fresh module scope, which
 * preserves the intended one-connect-per-page-load behaviour.
 */
const seededWallets = new Set<string>();

/**
 * Keyed by write key as well as address: two SDK instances for different write
 * keys are separate analytics destinations with separate queues, so the second
 * must still receive its own connect for the same wallet.
 */
const seedKey = (writeKey: string, address: string) =>
  `${writeKey}:${address.toLowerCase()}`;

/** Test hook. Real page loads reset this naturally. */
export function __resetSeededWallet(): void {
  seededWallets.clear();
}

/**
 * wagmi accepts an `account` as either a bare address or a viem Account
 * object. Normalise both to an address, or undefined when absent.
 */
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
  private pendingTransactions = new Map<string, {
    address: string;
    /**
     * Chain the transaction was broadcast on. Stored because a mutation may
     * name an explicit `chainId`, and the active chain can change between
     * broadcast and receipt; the confirmation must not be relabelled.
     */
    chainId?: number;
    data?: string;
    to?: string;
    value?: string;
    function_name?: string;
    function_args?: Record<string, unknown>;
    safeFunctionArgs?: Record<string, unknown>;
  }>();

  constructor(
    formoAnalytics: FormoAnalytics,
    wagmiConfig: WagmiConfig,
    queryClient?: QueryClient
  ) {
    this.formo = formoAnalytics;
    this.wagmiConfig = wagmiConfig;
    this.queryClient = queryClient;

    logger.info("WagmiEventHandler: Initializing Wagmi integration");

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

    // Subscribe to chain ID changes
    const chainIdUnsubscribe = this.wagmiConfig.subscribe(
      (state: WagmiState) => state.chainId,
      (chainId, prevChainId) => {
        this.handleChainChange(chainId, prevChainId);
      }
    );
    this.unsubscribers.push(chainIdUnsubscribe);

    // Subscribe to the active address.
    //
    // `state.status` is a single global value, so it stays "connected" when a
    // user switches account inside an already-connected wallet. Without this
    // the switch is invisible: no event, and the tracked address goes stale
    // and mis-attributes every later signature and transaction.
    const addressUnsubscribe = this.wagmiConfig.subscribe(
      (state: WagmiState) => this.getConnectedAddress(state),
      (address, prevAddress) => {
        this.handleActiveAddressChange(address, prevAddress);
      }
    );
    this.unsubscribers.push(addressUnsubscribe);

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
    try {
      const state = this.getState();
      if (state.status !== "connected") {
        return;
      }

      const address = this.getConnectedAddress(state);
      const chainId = state.chainId;

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

      this.trackingState.lastAddress = address;
      this.trackingState.lastChainId = chainId;
      this.trackingState.lastStatus = state.status;

      // Adopt the tracking state either way - the mutation handlers need an
      // address - but only emit the first time this page load adopts this
      // wallet. A rebuilt SDK instance over an unchanged connection is a
      // lifecycle event, not a user action.
      const walletKey = seedKey(this.formo.writeKey, address);
      if (seededWallets.has(walletKey)) {
        logger.debug(
          "WagmiEventHandler: Wallet already adopted this page load, not re-emitting connect",
          { address }
        );
        return;
      }
      seededWallets.add(walletKey);

      if (this.formo.isAutocaptureEnabled("connect")) {
        const connectorName = this.getConnectorName(state);
        // Fire and forget: awaiting here would either stall the constructor
        // or require holding the lock. Tracking state is already correct, so
        // a status change arriving mid-flight is handled normally.
        void Promise.resolve(
          this.formo.connect(
            { chainId, address },
            {
              ...(connectorName && { providerName: connectorName }),
            }
          )
        ).catch((error) => {
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
   * Handle status changes (connect/disconnect)
   */
  private async handleStatusChange(
    status: WagmiState["status"],
    prevStatus: WagmiState["status"]
  ): Promise<void> {
    // Prevent concurrent processing
    if (this.trackingState.isProcessing) {
      logger.debug("WagmiEventHandler: Already processing status change, skipping");
      return;
    }

    this.trackingState.isProcessing = true;

    try {
      const state = this.getState();
      const address = this.getConnectedAddress(state);
      const chainId = state.chainId;

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
        this.trackingState.lastAddress = undefined;
        this.trackingState.lastChainId = undefined;
        // A real disconnect ends the adoption, so a genuine reconnect later in
        // this same page load emits again.
        seededWallets.delete(seedKey(this.formo.writeKey, disconnectedAddress));

        // Clear central chain state regardless of autocapture so a later
        // event can't carry a stale excluded/!excluded chainId.
        this.formo.syncWalletState({ chainId: disconnectedChainId });

        if (this.formo.isAutocaptureEnabled("disconnect")) {
          await this.formo.disconnect({
            chainId: disconnectedChainId,
            address: disconnectedAddress,
          });
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
          if (this.trackingState.lastAddress === address) {
            if (this.trackingState.lastChainId !== chainId) {
              // Re-sync only. The chainId subscription observes this same
              // state update and owns the `chain` emission; emitting here too
              // would double count it.
              logger.info(
                "WagmiEventHandler: Tracked wallet re-entered connected on a different chain",
                { address, from: this.trackingState.lastChainId, to: chainId }
              );
              this.trackingState.lastChainId = chainId;
              this.formo.syncWalletState({ chainId, address });
            } else {
              logger.debug(
                "WagmiEventHandler: Ignoring re-entry to connected for an already tracked wallet",
                { address, chainId }
              );
            }
            this.trackingState.lastStatus = status;
            return;
          }

          this.trackingState.lastAddress = address;
          this.trackingState.lastChainId = chainId;

          // Sync central state unconditionally so tracking.excludeChains
          // is enforced even when connect autocapture is disabled.
          this.formo.syncWalletState({ chainId, address });

          if (this.formo.isAutocaptureEnabled("connect")) {
            const connectorName = this.getConnectorName(state);
            await this.formo.connect(
              { chainId, address },
              {
                ...(connectorName && { providerName: connectorName }),
              }
            );
          }
        }
      }

      this.trackingState.lastStatus = status;
    } catch (error) {
      logger.error("WagmiEventHandler: Error handling status change:", error);
    } finally {
      this.trackingState.isProcessing = false;
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
  private async handleActiveAddressChange(
    address: string | undefined,
    prevAddress: string | undefined
  ): Promise<void> {
    if (!address || address === prevAddress) return;
    // Already handled by the status listener (fresh connect, or the seed).
    if (this.trackingState.lastAddress === address) return;

    const state = this.getState();
    if (state.status !== "connected") return;

    // Prefer the chain of the connection that is now current. `state.chainId`
    // is global and can still describe the previous connection - with several
    // connections, or with syncConnectedChain disabled, they diverge.
    const chainId = this.getActiveConnectionChainId(state) ?? state.chainId;
    if (chainId === undefined) return;

    logger.info("WagmiEventHandler: Active account switched", {
      from: prevAddress,
      to: address,
      chainId,
    });

    this.trackingState.lastAddress = address;
    this.trackingState.lastChainId = chainId;

    // Sync central state unconditionally so tracking.excludeChains is
    // enforced even when connect autocapture is disabled.
    this.formo.syncWalletState({ chainId, address });

    if (this.formo.isAutocaptureEnabled("connect")) {
      try {
        const connectorName = this.getConnectorName(state);
        await this.formo.connect(
          { chainId, address },
          {
            ...(connectorName && { providerName: connectorName }),
          }
        );
      } catch (error) {
        logger.error(
          "WagmiEventHandler: Error tracking account switch:",
          error
        );
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
    if (chainId === prevChainId || chainId === undefined) {
      return;
    }

    // Only track chain changes when connected
    const state = this.getState();
    if (state.status !== "connected") {
      return;
    }

    const address = this.getConnectedAddress(state);
    if (!address) {
      logger.warn("WagmiEventHandler: Chain changed but no address found");
      return;
    }

    logger.info("WagmiEventHandler: Chain changed", {
      chainId,
      prevChainId,
      address,
    });

    this.trackingState.lastChainId = chainId;

    // Sync central state unconditionally so a chain switch to an
    // excluded chain is honored even when chain autocapture is disabled.
    this.formo.syncWalletState({ chainId, address });

    if (this.formo.isAutocaptureEnabled("chain")) {
      try {
        await this.formo.chain({ chainId, address });
      } catch (error) {
        logger.error("WagmiEventHandler: Error tracking chain change:", error);
      }
    }
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

    const query = event.query;
    const queryKey = query.queryKey;

    if (!queryKey || queryKey.length === 0) {
      return;
    }

    const queryType = queryKey[0] as string;

    // Only handle waitForTransactionReceipt queries
    if (queryType !== "waitForTransactionReceipt") {
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

    // The chain the transaction was actually broadcast on wins. A mutation may
    // have named an explicit chainId, and the active chain can change between
    // broadcast and receipt, which would otherwise relabel the confirmation.
    const chainId =
      pendingTx.chainId ?? queryChainId ?? this.trackingState.lastChainId;

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
        pendingTx?.safeFunctionArgs
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

    // Clean up old processed mutations to prevent memory leaks
    cleanupOldEntries(this.processedMutations);
  }

  /**
   * Handle signature mutations (signMessage, signTypedData)
   */
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
    const chainId = variables.chainId ?? this.trackingState.lastChainId;
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
        }
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
    const chainId = variables.chainId ?? this.trackingState.lastChainId;
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
          ...(chainId !== undefined && { chainId }),
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
        safeFunctionArgs
      );
    } catch (error) {
      logger.error(
        "WagmiEventHandler: Error handling transaction mutation:",
        error
      );
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
   * Chain of the connection that is currently active, which is authoritative
   * for that wallet. `state.chainId` is a single global value and can lag or
   * describe a different connection.
   */
  private getActiveConnectionChainId(state: WagmiState): number | undefined {
    if (!state.current) return undefined;
    return state.connections.get(state.current)?.chainId;
  }

  /**
   * Get the connector name from Wagmi state
   */
  private getConnectorName(state: WagmiState): string | undefined {
    if (!state.current) {
      return undefined;
    }

    const connection = state.connections.get(state.current);
    return connection?.connector.name;
  }

  /**
   * Clean up all subscriptions
   */
  public cleanup(): void {
    logger.debug("WagmiEventHandler: Cleaning up subscriptions");
    
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
    this.pendingTransactions.clear();
    logger.debug("WagmiEventHandler: Cleanup complete");
  }
}

