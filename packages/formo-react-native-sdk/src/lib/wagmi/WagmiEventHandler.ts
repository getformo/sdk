/**
 * WagmiEventHandler for React Native
 *
 * Handles wallet event tracking by hooking into Wagmi v2's config.subscribe()
 * and TanStack Query's MutationCache and QueryCache.
 */

import { SignatureStatus, TransactionStatus } from "../../types/events";
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

// Interface for FormoAnalytics to avoid circular dependency
interface IFormoAnalyticsInstance {
  connect(
    params: { chainId: number; address: string },
    properties?: Record<string, unknown>
  ): Promise<void>;
  disconnect(params?: {
    chainId?: number;
    address?: string;
  }): Promise<void>;
  chain(params: { chainId: number; address?: string }): Promise<void>;
  signature(params: {
    status: SignatureStatus;
    chainId?: number;
    address: string;
    message: string;
    signatureHash?: string;
  }): Promise<void>;
  transaction(
    params: {
      status: TransactionStatus;
      chainId: number;
      address: string;
      data?: string;
      to?: string;
      value?: string;
      transactionHash?: string;
      function_name?: string;
      function_args?: Record<string, unknown>;
    },
    additionalProperties?: Record<string, unknown>
  ): Promise<void>;
  isAutocaptureEnabled(
    eventType: "connect" | "disconnect" | "signature" | "transaction" | "chain"
  ): boolean;
}

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
 */
function cleanupOldEntries(
  set: Set<string>,
  maxSize = 1000,
  removeCount = 500
): void {
  if (set.size > maxSize) {
    const entries = Array.from(set);
    for (let i = 0; i < removeCount && i < entries.length; i++) {
      const entry = entries[i];
      if (entry) {
        set.delete(entry);
      }
    }
  }
}

export class WagmiEventHandler {
  private formo: IFormoAnalyticsInstance;
  private wagmiConfig: WagmiConfig;
  private queryClient?: QueryClient;
  private unsubscribers: UnsubscribeFn[] = [];
  private trackingState: WagmiTrackingState = {
    isProcessing: false,
  };
  private processedMutations = new Set<string>();
  private processedQueries = new Set<string>();

  /**
   * Store transaction details from BROADCASTED events for use in CONFIRMED/REVERTED
   * Key: transactionHash (lowercase), Value: transaction details
   */
  private pendingTransactions = new Map<
    string,
    {
      address: string;
      data?: string;
      to?: string;
      value?: string;
      function_name?: string;
      function_args?: Record<string, unknown>;
      safeFunctionArgs?: Record<string, unknown>;
    }
  >();

  constructor(
    formoAnalytics: IFormoAnalyticsInstance,
    wagmiConfig: WagmiConfig,
    queryClient?: QueryClient
  ) {
    this.formo = formoAnalytics;
    this.wagmiConfig = wagmiConfig;
    this.queryClient = queryClient;

    logger.info("WagmiEventHandler: Initializing Wagmi integration");

    this.setupConnectionListeners();

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

    // Subscribe to status changes
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
    if (this.trackingState.isProcessing) {
      logger.debug(
        "WagmiEventHandler: Already processing status change, skipping"
      );
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
   * Handle query cache events for transaction confirmations
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
    const receipt = state.data as { status?: string } | undefined;
    const receiptStatus = receipt?.status;

    // Create unique key including receipt status to distinguish CONFIRMED vs REVERTED
    const queryStateKey = `${query.queryHash}:${state.status}:${receiptStatus || ""}`;

    if (this.processedQueries.has(queryStateKey)) {
      return;
    }

    this.processedQueries.add(queryStateKey);

    logger.debug("WagmiEventHandler: Query event", {
      queryType,
      queryHash: query.queryHash,
      status: state.status,
    });

    this.handleTransactionReceiptQuery(query);

    cleanupOldEntries(this.processedQueries);
  }

  /**
   * Handle waitForTransactionReceipt query completion
   */
  private handleTransactionReceiptQuery(query: {
    state: { status: string; data?: unknown };
    queryKey: readonly unknown[];
  }): void {
    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    const state = query.state;
    const queryKey = query.queryKey;

    if (state.status !== "success") {
      return;
    }

    const params = queryKey[1] as
      | { hash?: string; chainId?: number }
      | undefined;
    const transactionHash = params?.hash;
    const chainId = params?.chainId || this.trackingState.lastChainId;

    if (!transactionHash) {
      logger.warn(
        "WagmiEventHandler: Transaction receipt query but no hash found"
      );
      return;
    }

    const normalizedHash = transactionHash.toLowerCase();
    const pendingTx = this.pendingTransactions.get(normalizedHash);
    const address = pendingTx?.address || this.trackingState.lastAddress;

    if (!address) {
      logger.warn(
        "WagmiEventHandler: Transaction receipt query but no address available"
      );
      return;
    }

    try {
      const receipt = state.data as {
        status?: "success" | "reverted";
        blockNumber?: bigint;
        gasUsed?: bigint;
      } | undefined;

      const txStatus =
        receipt?.status === "reverted"
          ? TransactionStatus.REVERTED
          : TransactionStatus.CONFIRMED;

      logger.info("WagmiEventHandler: Tracking transaction confirmation", {
        status: txStatus,
        transactionHash,
        address,
        chainId,
      });

      this.formo
        .transaction(
          {
            status: txStatus,
            chainId: chainId || 0,
            address,
            transactionHash,
            ...(pendingTx?.data && { data: pendingTx.data }),
            ...(pendingTx?.to && { to: pendingTx.to }),
            ...(pendingTx?.value && { value: pendingTx.value }),
            ...(pendingTx?.function_name && {
              function_name: pendingTx.function_name,
            }),
            ...(pendingTx?.function_args && {
              function_args: pendingTx.function_args,
            }),
          },
          pendingTx?.safeFunctionArgs
        )
        .catch((error) => {
          logger.error(
            "WagmiEventHandler: Error tracking transaction confirmation:",
            error
          );
        });

      this.pendingTransactions.delete(normalizedHash);
    } catch (error) {
      logger.error(
        "WagmiEventHandler: Error handling transaction receipt query:",
        error
      );
    }
  }

  /**
   * Handle mutation cache events
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

    const mutationStateKey = `${mutation.mutationId}:${state.status}`;

    if (this.processedMutations.has(mutationStateKey)) {
      return;
    }

    this.processedMutations.add(mutationStateKey);

    logger.debug("WagmiEventHandler: Mutation event", {
      mutationType,
      mutationId: mutation.mutationId,
      status: state.status,
    });

    if (mutationType === "signMessage" || mutationType === "signTypedData") {
      this.handleSignatureMutation(
        mutationType as WagmiMutationKey,
        mutation
      );
    }

    if (
      mutationType === "sendTransaction" ||
      mutationType === "writeContract"
    ) {
      this.handleTransactionMutation(
        mutationType as WagmiMutationKey,
        mutation
      );
    }

    cleanupOldEntries(this.processedMutations);
  }

  /**
   * Handle signature mutations
   */
  private handleSignatureMutation(
    mutationType: WagmiMutationKey,
    mutation: MutationCacheEvent["mutation"]
  ): void {
    if (!this.formo.isAutocaptureEnabled("signature")) {
      return;
    }

    const state = mutation.state;
    const variables = state.variables || {};
    const chainId = this.trackingState.lastChainId;
    const address = this.trackingState.lastAddress;

    if (!address) {
      logger.warn(
        "WagmiEventHandler: Signature event but no address available"
      );
      return;
    }

    try {
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
        return;
      }

      let message: string;
      if (mutationType === "signMessage") {
        message = (variables.message as string) || "";
      } else {
        message = JSON.stringify(variables.message || variables.types || {});
      }

      logger.info("WagmiEventHandler: Tracking signature event", {
        status,
        mutationType,
        address,
        chainId,
      });

      this.formo
        .signature({
          status,
          chainId,
          address,
          message,
          ...(signatureHash && { signatureHash }),
        })
        .catch((error) => {
          logger.error("WagmiEventHandler: Error tracking signature:", error);
        });
    } catch (error) {
      logger.error(
        "WagmiEventHandler: Error handling signature mutation:",
        error
      );
    }
  }

  /**
   * Handle transaction mutations
   */
  private handleTransactionMutation(
    mutationType: WagmiMutationKey,
    mutation: MutationCacheEvent["mutation"]
  ): void {
    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    const state = mutation.state;
    const variables = state.variables || {};
    const chainId =
      this.trackingState.lastChainId ||
      (variables.chainId as number | undefined);

    // For sendTransaction, user's address is the 'from'
    // For writeContract, variables.address is the contract address, not the user
    // variables.account can be a string address or an Account object
    const accountValue = variables.account;
    const accountAddress =
      typeof accountValue === "string"
        ? accountValue
        : (accountValue as { address?: string } | undefined)?.address;
    const userAddress =
      this.trackingState.lastAddress ||
      accountAddress ||
      (variables.from as string | undefined);

    if (!userAddress) {
      logger.warn(
        "WagmiEventHandler: Transaction event but no address available"
      );
      return;
    }

    if (!chainId || chainId === 0) {
      logger.warn(
        "WagmiEventHandler: Transaction event but no valid chainId available"
      );
      return;
    }

    try {
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
        return;
      }

      // Extract transaction details based on mutation type
      let data: string | undefined;
      let to: string | undefined;
      let function_name: string | undefined;
      let function_args: Record<string, unknown> | undefined;
      const value = variables.value?.toString();

      if (mutationType === "writeContract") {
        // For writeContract, extract function info and encode data
        const {
          abi,
          functionName: fnName,
          args,
          address: contractAddress,
        } = variables as {
          abi?: unknown[];
          functionName?: string;
          args?: unknown[];
          address?: string;
        };
        to = contractAddress;
        function_name = fnName;

        if (abi && fnName) {
          // Extract function arguments as a name-value map
          function_args = extractFunctionArgs(
            abi as Parameters<typeof extractFunctionArgs>[0],
            fnName,
            args
          );

          // Encode the function data if viem is available
          const encodedData = encodeWriteContractData(
            abi as Parameters<typeof encodeWriteContractData>[0],
            fnName,
            args
          );
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
        data = variables.data as string | undefined;
        to = variables.to as string | undefined;
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
      const safeFunctionArgs = buildSafeFunctionArgs(
        function_args,
        RESERVED_FIELDS
      );

      // Store transaction details for BROADCASTED to use in CONFIRMED/REVERTED
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

        logger.debug(
          "WagmiEventHandler: Stored pending transaction for confirmation",
          { transactionHash: normalizedHash }
        );

        // Clean up old pending transactions (keep max 100)
        if (this.pendingTransactions.size > 100) {
          const keys = Array.from(this.pendingTransactions.keys());
          for (let i = 0; i < 50 && i < keys.length; i++) {
            const key = keys[i];
            if (key) {
              this.pendingTransactions.delete(key);
            }
          }
        }
      }

      this.formo
        .transaction(
          {
            status,
            chainId,
            address: userAddress,
            ...(data && { data }),
            ...(to && { to }),
            ...(value && { value }),
            ...(transactionHash && { transactionHash }),
            ...(function_name && { function_name }),
            ...(function_args && { function_args }),
          },
          safeFunctionArgs
        )
        .catch((error) => {
          logger.error(
            "WagmiEventHandler: Error tracking transaction:",
            error
          );
        });
    } catch (error) {
      logger.error(
        "WagmiEventHandler: Error handling transaction mutation:",
        error
      );
    }
  }

  /**
   * Get current Wagmi state
   */
  private getState(): WagmiState {
    if (typeof this.wagmiConfig.getState === "function") {
      return this.wagmiConfig.getState();
    }

    if (this.wagmiConfig.state) {
      return this.wagmiConfig.state;
    }

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
   * Get connected address from state
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
   * Get connector name from state
   */
  private getConnectorName(state: WagmiState): string | undefined {
    if (!state.current) {
      return undefined;
    }

    const connection = state.connections.get(state.current);
    return connection?.connector.name;
  }

  /**
   * Clean up subscriptions
   */
  public cleanup(): void {
    logger.info("WagmiEventHandler: Cleaning up subscriptions");

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
    logger.info("WagmiEventHandler: Cleanup complete");
  }
}
