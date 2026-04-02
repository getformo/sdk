/**
 * SolanaManager
 *
 * Manages the lifecycle of the Solana store integration.
 * Subscribes to framework-kit's zustand store for automatic event capture
 * of wallet connect/disconnect and transaction lifecycle events.
 *
 * For signMessage/signTransaction tracking (not captured by the store),
 * use formo.signature() directly with the address and chainId.
 *
 * For manual event tracking without the store, use the core API directly:
 * formo.transaction(), formo.signature(), formo.connect(), formo.disconnect().
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { logger } from "../logger";
import { SolanaStoreHandler } from "./SolanaStoreHandler";
import { SolanaCluster, SolanaOptions } from "./types";
import { SolanaClientStore } from "./storeTypes";

export class SolanaManager {
  private storeHandler?: SolanaStoreHandler;
  private pendingCluster?: SolanaCluster;

  constructor(
    private formo: FormoAnalytics,
    options?: SolanaOptions
  ) {
    if (options?.store) {
      logger.info("SolanaManager: Initializing store-based Solana tracking");
      this.storeHandler = new SolanaStoreHandler(formo, options.store, {
        cluster: options.cluster,
      });
    } else if (options?.cluster) {
      // Store pending cluster for when setStore is called later
      this.pendingCluster = options.cluster;
    }
  }

  /**
   * Set the framework-kit zustand store for automatic event tracking.
   * This enables autocapture mode — connect/disconnect and transaction events
   * are tracked automatically by subscribing to store state changes.
   *
   * @param store - The framework-kit client store (client.store)
   * @param options - Optional configuration
   *
   * @example
   * ```tsx
   * import { createClient } from '@solana-foundation/framework-kit';
   *
   * const client = createClient({ endpoint: '...', walletConnectors: autoDiscover() });
   * formo.solana.setStore(client.store);
   * ```
   */
  setStore(store: SolanaClientStore, options?: { cluster?: SolanaCluster }): void {
    this.storeHandler?.cleanup();
    this.storeHandler = new SolanaStoreHandler(this.formo, store, {
      cluster: options?.cluster || this.pendingCluster,
    });
    this.pendingCluster = undefined;
  }

  /**
   * Update the cluster/network. Only needed if the store endpoint doesn't
   * contain a recognizable cluster name (e.g. custom RPC URLs).
   * In most cases, the cluster is auto-detected from the store's endpoint.
   */
  setCluster(cluster: SolanaCluster): void {
    if (this.storeHandler) {
      this.storeHandler.setCluster(cluster);
    } else {
      this.pendingCluster = cluster;
    }
  }

  cleanup(): void {
    this.storeHandler?.cleanup();
    this.storeHandler = undefined;
  }
}
