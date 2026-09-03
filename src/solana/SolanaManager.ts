/**
 * SolanaManager
 *
 * Owns the two ways the SDK learns about Solana wallets:
 *
 *  1. `SolanaWalletStandardRegistry`: discovers wallets through the Wallet
 *     Standard and reports detect / connect / disconnect. On by default, so a
 *     `@solana/wallet-adapter`, Privy, Dynamic, Reown or hand-rolled app is
 *     covered with no configuration, exactly like EVM wallets through
 *     EIP-6963. `solana: false` turns it off.
 *  2. `SolanaStoreHandler`: subscribes to framework-kit's zustand store for
 *     connect / disconnect / cluster changes AND the transaction lifecycle.
 *     Opt-in through `solana: { store }` or `formo.solana.setStore()`.
 *
 * Both observe the same Wallet Standard connection when a framework-kit app
 * connects, so while a store handler is attached the registry leaves connect
 * and disconnect to it. One connect per connection, whichever path an app is
 * on.
 *
 * For signMessage/signTransaction tracking (not captured by either path),
 * use formo.signature() directly with the address and chainId.
 *
 * For manual event tracking, use the core API directly:
 * formo.transaction(), formo.signature(), formo.connect(), formo.disconnect().
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { logger } from "../logger";
import { SolanaStoreHandler } from "./SolanaStoreHandler";
import { SolanaWalletStandardRegistry } from "./SolanaWalletStandardRegistry";
import { SolanaCluster, SolanaOptions } from "./types";
import { SolanaClientStore } from "./storeTypes";

export class SolanaManager {
  private storeHandler?: SolanaStoreHandler;
  private registry?: SolanaWalletStandardRegistry;
  private pendingCluster?: SolanaCluster;

  /**
   * @param formo - The SDK instance events are reported to.
   * @param options - `options.solana` as passed to the SDK, if an object.
   * @param discover - Whether to discover wallets through the Wallet
   *   Standard. False only when the host app passed `solana: false`.
   */
  constructor(
    private formo: FormoAnalytics,
    options?: SolanaOptions,
    discover = true
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

    if (discover) {
      this.registry = new SolanaWalletStandardRegistry(
        {
          isAutocaptureEnabled: (t) => this.formo.isAutocaptureEnabled(t),
          detect: (params) => this.formo.detect(params),
          connect: (params, properties) =>
            this.formo.connect(params, properties),
          disconnect: (params) => this.formo.disconnect(params),
          chain: (params) => this.formo.chain(params),
          ownsWalletEvents: () => !this.storeHandler,
        },
        { cluster: options?.cluster }
      );
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
   * import { createClient, autoDiscover } from '@solana/client';
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
   * Update the cluster/network.
   *
   * With a framework-kit store, only needed if the store endpoint doesn't
   * contain a recognizable cluster name (e.g. custom RPC URLs). Without one,
   * this is how a non-mainnet app tells the SDK which cluster its Wallet
   * Standard connections are on, since the standard itself cannot say.
   */
  setCluster(cluster: SolanaCluster): void {
    if (this.storeHandler) {
      this.storeHandler.setCluster(cluster);
    } else {
      this.pendingCluster = cluster;
    }
    this.registry?.setCluster(cluster);
  }

  /** Names of the Wallet Standard wallets discovered so far. */
  get discoveredWallets(): string[] {
    return this.registry?.walletNames ?? [];
  }

  cleanup(): void {
    this.storeHandler?.cleanup();
    this.storeHandler = undefined;
    this.registry?.cleanup();
    this.registry = undefined;
  }
}
