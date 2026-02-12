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

    logger.info("WagmiEventHandler: Connection listeners set up successfully");
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

      // Handle disconnect
      if (status === "disconnected" && prevStatus === "connected") {
        if (this.formo.isAutocaptureEnabled("disconnect")) {
          await this.formo.disconnect({
            chainId: this.trackingState.lastChainId,
            address: this.trackingState.lastAddress,
          });
        }
        this.trackingState.lastAddress = undefined;
        this.trackingState.lastChainId = undefined;
      }

      // Handle connect
      if (status === "connected" && prevStatus !== "connected") {
        if (address && chainId !== undefined) {
          this.trackingState.lastAddress = address;
          this.trackingState.lastChainId = chainId;

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
    const chainId = params?.chainId || this.trackingState.lastChainId;

    if (!transactionHash) {
      logger.warn("WagmiEventHandler: Transaction receipt query but no hash found");
      return;
    }

    // Retrieve stored transaction details from BROADCASTED event
    // Normalize hash to lowercase for consistent lookup
    const normalizedHash = transactionHash.toLowerCase();
    const pendingTx = this.pendingTransactions.get(normalizedHash);

    // Use the original sender address from BROADCASTED event if available,
    // otherwise fall back to current connected address.
    // This handles wallet switches between broadcast and confirmation.
    const address = pendingTx?.address || this.trackingState.lastAddress;

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

      // Determine transaction status from receipt
      // receipt.status is 'success' or 'reverted' in viem
      const txStatus = receipt?.status === "reverted"
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
    const chainId = this.trackingState.lastChainId;
    const address = this.trackingState.lastAddress;

    if (!address) {
      logger.warn("WagmiEventHandler: Signature event but no address available");
      return;
    }

    try {
      // Map Wagmi mutation status to Formo signature status
      let status: SignatureStatus;
      let signatureHash: string | undefined;

      if (state.status === "pending") {
        status = SignatureStatus.REQUESTED;
      } else if (state.status === "success") {
        status = SignatureStatus.CONFIRMED;
        signatureHash = state.data as string;
      } else if (state.status === "error") {
        status = SignatureStatus.REJECTED;
      } else {
        return; // Ignore idle state
      }

      // Extract message from variables
      let message: string;
      if (mutationType === "signMessage") {
        message = variables.message || "";
      } else {
        // For signTypedData, stringify the typed data
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
          ...(signatureHash && { signatureHash }),
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
    const chainId = this.trackingState.lastChainId || variables.chainId;
    // For sendTransaction, user's address is the 'from'
    // For writeContract, variables.address is the contract address, not the user
    // variables.account can be a string address or an Account object with an address property
    const accountValue = variables.account;
    const accountAddress =
      typeof accountValue === "string"
        ? accountValue
        : accountValue?.address;
    const userAddress =
      this.trackingState.lastAddress || accountAddress || variables.from;

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
        const { abi, functionName: fnName, args, address: contractAddress } = variables;
        to = contractAddress;
        function_name = fnName;

        if (abi && fnName) {
          // Extract function arguments as a name-value map
          function_args = extractFunctionArgs(abi, fnName, args);

          // Encode the function data synchronously if viem is available
          const encodedData = encodeWriteContractData(abi, fnName, args);
          if (encodedData) {
            data = encodedData;
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

