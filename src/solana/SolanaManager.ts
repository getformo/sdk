/**
 * SolanaManager
 *
 * Owns the two ways the SDK learns about Solana wallets:
 *
 *  1. `SolanaWalletStandardRegistry`: discovers wallets through the Wallet
 *     Standard and reports detect / connect / disconnect. On by default, so a
 *     compatible wallets registered by Solana Kit, wallet-adapter,
 *     framework-kit, or another host are covered with no configuration,
 *     exactly like EVM wallets through EIP-6963. `solana: false` turns it off.
 *  2. `SolanaStoreHandler`: subscribes to framework-kit's zustand store for
 *     connect / disconnect / cluster changes AND the transaction lifecycle.
 *     Opt-in through `solana: { store }` or `formo.solana.setStore()`.
 *
 * Both observe the same Wallet Standard connection when a framework-kit app
 * connects. A store supplied at initialization owns wallet events; a store
 * attached later takes ownership when it observes its first connection and
 * adopts any connect the registry already reported. One connect per
 * connection, whichever path an app is on.
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
import {
  SOLANA_CLUSTERS_BY_ID,
  SolanaCluster,
  SolanaOptions,
} from "./types";
import { SolanaClientStore } from "./storeTypes";

export class SolanaManager {
  private storeHandler?: SolanaStoreHandler;
  private registry?: SolanaWalletStandardRegistry;
  private pendingCluster?: SolanaCluster;
  private storeOwnsWalletEvents = false;

  /**
   * @param formo - The SDK instance events are reported to.
   * @param options - `options.solana` as passed to the SDK, if an object.
   * @param enabled - Whether Solana tracking is enabled. False only when the
   *   host app passed `solana: false`; both discovery and stores then stay off.
   */
  constructor(
    private formo: FormoAnalytics,
    options?: SolanaOptions,
    private readonly enabled = true
  ) {
    if (!enabled) return;

    if (options?.cluster) {
      // Store pending cluster for when setStore is called later
      this.pendingCluster = options.cluster;
    }

    // A store supplied at initialization owns wallet events from the outset:
    // unlike a store attached later, it has not missed any prior registry
    // state and it knows the cluster more precisely.
    this.storeOwnsWalletEvents = !!options?.store;

    this.registry = new SolanaWalletStandardRegistry(
      {
        isAutocaptureEnabled: (t) => this.formo.isAutocaptureEnabled(t),
        willTrackEvent: (chainId) => this.formo.willTrackEvent(chainId),
        detect: (params) => this.formo.detect(params),
        connect: (params, properties) =>
          this.formo.connect(params, properties),
        disconnect: (params) => this.formo.disconnect(params),
        chain: (params) => this.formo.chain(params),
        ownsWalletEvents: () => !this.storeOwnsWalletEvents,
      },
      { cluster: options?.cluster }
    );

    if (options?.store) {
      logger.info("SolanaManager: Initializing store-based Solana tracking");
      this.attachStore(options.store, options.cluster);
    }
  }

  private attachStore(
    store: SolanaClientStore,
    cluster?: SolanaCluster
  ): void {
    this.storeHandler = new SolanaStoreHandler(this.formo, store, {
      cluster,
      beforeWalletConnect: (connection) => {
        // The store's cluster is authoritative even when chain autocapture is
        // disabled. Keep central attribution correct without manufacturing a
        // chain event in that mode.
        this.formo.syncWalletState({
          address: connection.address,
          chainId: connection.chainId,
        });
        if (this.storeOwnsWalletEvents) return true;

        const reported = this.registry?.takeReportedConnection(
          connection.address,
          connection.rdns
        );
        this.storeOwnsWalletEvents = true;

        // If Wallet Standard got there first, the store adopts that live
        // connection instead of emitting it again. Correct its cluster if
        // the store has more precise information.
        if (!reported) return true;
        if (
          reported.chainId !== connection.chainId &&
          this.formo.isAutocaptureEnabled("chain")
        ) {
          this.formo.chain(connection).catch((error) => {
            logger.error(
              "SolanaManager: Error correcting cluster during store handoff",
              error
            );
          });
        }
        return false;
      },
    });

    // Keep the registry's snapshot on the store's detected cluster. This is
    // silent once the store owns events; during a late handoff it corrects a
    // registry-reported connection before the store adopts it.
    const detectedCluster = SOLANA_CLUSTERS_BY_ID[this.storeHandler.getChainId()];
    if (detectedCluster) this.registry?.setCluster(detectedCluster);
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
    if (!this.enabled) {
      logger.warn("SolanaManager: Ignoring setStore because Solana is disabled");
      return;
    }
    this.storeHandler?.cleanup();
    this.storeHandler = undefined;
    this.storeOwnsWalletEvents = false;
    this.attachStore(store, options?.cluster || this.pendingCluster);
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
    if (!this.enabled) return;
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
    this.storeOwnsWalletEvents = false;
    this.registry?.cleanup();
    this.registry = undefined;
  }
}
