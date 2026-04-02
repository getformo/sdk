/**
 * SolanaManager
 *
 * Manages the lifecycle of the Solana store integration.
 * Subscribes to framework-kit's zustand store for automatic event capture
 * of wallet connect/disconnect and transaction lifecycle events.
 *
 * For signMessage/signTransaction tracking (not captured by the store),
 * use formo.solana.trackSignature() or formo.signature() directly.
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

  constructor(
    private formo: FormoAnalytics,
    options?: SolanaOptions
  ) {
    if (options?.store) {
      logger.info("SolanaManager: Initializing store-based Solana tracking");
      this.storeHandler = new SolanaStoreHandler(formo, options.store, {
        cluster: options.cluster,
      });
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
      cluster: options?.cluster,
    });
  }

  /**
   * Update the cluster/network. Only needed if the store endpoint doesn't
   * contain a recognizable cluster name (e.g. custom RPC URLs).
   * In most cases, the cluster is auto-detected from the store's endpoint.
   */
  setCluster(cluster: SolanaCluster): void {
    this.storeHandler?.setCluster(cluster);
  }

  /**
   * Track a signature (signMessage / signTransaction) event.
   *
   * Framework-kit's store does not track signature state, so this must be
   * called explicitly. Uses the store's current wallet address for attribution.
   *
   * Alternatively, you can call formo.signature() directly if you have the
   * address and chainId available.
   *
   * @param status - The signature status
   * @param options - Details about the signature request
   *
   * @example
   * ```tsx
   * formo.solana.trackSignature('requested', { message: 'Hello' });
   * try {
   *   const sig = await wallet.signMessage(encodedMessage);
   *   formo.solana.trackSignature('confirmed', { message: 'Hello', signatureHash: toHex(sig) });
   * } catch (e) {
   *   formo.solana.trackSignature('rejected', { message: 'Hello' });
   * }
   * ```
   */
  trackSignature(
    status: "requested" | "confirmed" | "rejected",
    options?: { message?: string; signatureHash?: string }
  ): void {
    if (this.storeHandler) {
      this.storeHandler.trackSignature(status, options);
    } else {
      logger.warn(
        "SolanaManager: trackSignature() called but no store is configured. " +
        "Use formo.solana.setStore(client.store) or call formo.signature() directly."
      );
    }
  }

  cleanup(): void {
    this.storeHandler?.cleanup();
    this.storeHandler = undefined;
  }
}
