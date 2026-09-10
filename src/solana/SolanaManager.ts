/**
 * SolanaManager
 *
 * Owns the two ways the SDK learns about Solana wallets:
 *
 *  1. `SolanaWalletStandardRegistry`: discovers wallets through the Wallet
 *     Standard and reports detect / connect / disconnect. On by default, so
 *     compatible wallets registered by Solana Kit, wallet-adapter,
 *     framework-kit, or another host are covered with no configuration,
 *     exactly like EVM wallets through EIP-6963. `solana: false` turns it off.
 *  2. `SolanaStoreHandler`: subscribes to framework-kit's zustand store for
 *     connect / disconnect / cluster changes AND the transaction lifecycle.
 *     Opt-in through `solana: { store }` or `formo.solana.setStore()`.
 *
 * Both observe the same Wallet Standard connection when a framework-kit app
 * connects. A store, whether supplied at initialization or attached later,
 * takes ownership of wallet events when it observes its first connection
 * and adopts any connect the registry already reported. Until then the
 * registry reports, so a connection the store never sees is not lost. One
 * connect per connection, whichever path an app is on.
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
  SolanaCaptureDeps,
  SolanaCluster,
  SolanaOptions,
  SolanaStoreHandlerDeps,
} from "./types";
import { SolanaClientStore } from "./storeTypes";

export class SolanaManager {
  private storeHandler?: SolanaStoreHandler;
  private registry?: SolanaWalletStandardRegistry;
  /** The cluster the app named, through options or setCluster(). Outlives any store. */
  private cluster?: SolanaCluster;
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

    this.cluster = options?.cluster;

    // Attach before discovery starts: the registry reports a wallet
    // authorized before the SDK the moment it is constructed, and that
    // report must carry the store's detected cluster, not the default.
    let cluster = options?.cluster;
    if (options?.store) {
      logger.info("SolanaManager: Initializing store-based Solana tracking");
      this.attachStore(options.store, cluster);
      if (!cluster) cluster = SOLANA_CLUSTERS_BY_ID[this.storeHandler!.getChainId()];
    }
    this.registry = new SolanaWalletStandardRegistry(
      {
        ...this.captureDeps(),
        willTrackEvent: (chainId) => this.formo.willTrackEvent(chainId),
        detect: (params) => this.formo.detect(params),
        // A registry disconnect clears the Solana namespace once its event
        // is built. If the store's wallet held the slot, put it back.
        disconnect: (params) => {
          const restore = this.formo.deferWalletRestore(params.chainId);
          return this.formo.disconnect(params).then(() => {
            const live = this.storeHandler?.restorableConnection();
            if (live && !this.formo.solanaAddress) restore(live);
          });
        },
        // Same hand-back as the disconnect wrapper, for the capture-off path.
        syncWalletState: (params) => {
          this.formo.syncWalletState(params);
          if (params.address) return;
          const live = this.storeHandler?.restorableConnection();
          if (live && !this.formo.solanaAddress) this.formo.restoreWalletState(live);
        },
        currentAddress: () => this.formo.currentAddress,
        ownsWalletEvents: () => !this.storeOwnsWalletEvents,
      },
      { cluster }
    );
  }

  /**
   * The SDK surface both capture paths share. Neither takes the SDK class
   * itself: naming the surface keeps this module from depending on the class
   * that owns it, and lets a test build one without it.
   */
  private captureDeps(): SolanaCaptureDeps {
    return {
      isAutocaptureEnabled: (type) => this.formo.isAutocaptureEnabled(type),
      connect: (params, properties) => this.formo.connect(params, properties),
      disconnect: (params) => this.formo.disconnect(params),
      chain: (params) => this.formo.chain(params),
      restoreWalletState: (params) => this.formo.restoreWalletState(params),
      deferWalletRestore: (chainId) => this.formo.deferWalletRestore(chainId),
      solanaAddress: () => this.formo.solanaAddress,
    };
  }

  private attachStore(
    store: SolanaClientStore,
    cluster?: SolanaCluster
  ): void {
    const deps: SolanaStoreHandlerDeps = {
      ...this.captureDeps(),
      transaction: (params) => this.formo.transaction(params),
    };
    this.storeHandler = new SolanaStoreHandler(deps, store, {
      cluster,
      // The registry reports until the store observes a connection, so it
      // must follow the store's endpoint in the meantime.
      onClusterChange: (detected) => this.registry?.setCluster(detected),
      // The store's wallet leaving clears the Solana namespace. A connection
      // the registry reported before the store took ownership is still
      // live; put it back if nothing else holds the slot.
      afterWalletDisconnect: (departed, restore, captured) => {
        // Captured: disconnect() emptied the slot, so anything in it arrived
        // since and keeps it. Otherwise only the departed wallet may be evicted.
        const held = this.formo.solanaAddress;
        if (held && (captured || held !== departed.address)) return;
        if (held) this.formo.syncWalletState({ chainId: departed.chainId });
        const live = this.registry?.newestConnection(departed.address);
        if (!live) return;
        // The deferred writer is for the path that awaited disconnect().
        if (captured) restore(live);
        else this.formo.restoreWalletState(live);
      },
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
        if (!reported) {
          // Nothing to adopt. Either the registry never reported this
          // connection, or it reported it under another identity, in which
          // case the store is about to emit a second connect for the same
          // live connection. Both paths derive the rdns from the wallet's
          // own name, so a mismatch means the store's connector is labelled
          // differently from the registered wallet.
          const held = this.registry?.reportedConnectionRdns(connection.address);
          if (held) {
            logger.warn(
              "SolanaManager: Store connector does not match the discovered wallet; the connection is reported twice",
              { storeRdns: connection.rdns, walletRdns: held }
            );
          }
          return true;
        }
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
      logger.warn(
        "SolanaManager: Ignoring setStore. Solana tracking is off for this instance (solana: false, or the SDK was cleaned up)"
      );
      return;
    }
    this.storeHandler?.cleanup();
    this.storeHandler = undefined;
    this.storeOwnsWalletEvents = false;
    if (options?.cluster) this.cluster = options.cluster;
    this.attachStore(store, this.cluster);
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
    this.cluster = cluster;
    this.storeHandler?.setCluster(cluster);
    this.registry?.setCluster(cluster);
  }

  /** @see SolanaWalletStandardRegistry.restorableFrom */
  onReset(): void {
    this.registry?.onReset();
    this.storeHandler?.onReset();
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
