/**
 * WagmiEventHandler for React Native
 *
 * Handles wallet event tracking by hooking into Wagmi v2's config.subscribe()
 * and TanStack Query's MutationCache.
 */

import { SignatureStatus, TransactionStatus } from "../../types/events";
import { logger } from "../logger";
import {
  WagmiConfig,
  WagmiState,
  QueryClient,
  MutationCacheEvent,
  UnsubscribeFn,
  WagmiTrackingState,
  WagmiMutationKey,
} from "./types";

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
  transaction(params: {
    status: TransactionStatus;
    chainId: number;
    address: string;
    data?: string;
    to?: string;
    value?: string;
    transactionHash?: string;
  }): Promise<void>;
  isAutocaptureEnabled(
    eventType: "connect" | "disconnect" | "signature" | "transaction" | "chain"
  ): boolean;
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

    // Cleanup old mutations
    if (this.processedMutations.size > 1000) {
      const entries = Array.from(this.processedMutations);
      for (let i = 0; i < 500; i++) {
        const entry = entries[i];
        if (entry) {
          this.processedMutations.delete(entry);
        }
      }
    }
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

      this.formo.signature({
        status,
        chainId,
        address,
        message,
        ...(signatureHash && { signatureHash }),
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
    const address =
      this.trackingState.lastAddress ||
      (variables.account as string | undefined) ||
      (variables.address as string | undefined);

    if (!address) {
      logger.warn(
        "WagmiEventHandler: Transaction event but no address available"
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

      const data = variables.data as string | undefined;
      const to =
        (variables.to as string | undefined) ||
        (variables.address as string | undefined);
      const value = variables.value?.toString();

      logger.info("WagmiEventHandler: Tracking transaction event", {
        status,
        mutationType,
        address,
        chainId,
        transactionHash,
      });

      this.formo.transaction({
        status,
        chainId: chainId || 0,
        address,
        ...(data && { data }),
        ...(to && { to }),
        ...(value && { value }),
        ...(transactionHash && { transactionHash }),
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
    logger.info("WagmiEventHandler: Cleanup complete");
  }
}
