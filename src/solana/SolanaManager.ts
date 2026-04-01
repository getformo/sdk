/**
 * SolanaManager
 *
 * Manages the lifecycle of Solana integrations, supporting two modes:
 *
 * 1. **Store mode** (recommended): Subscribes to framework-kit's zustand store
 *    for automatic event capture — similar to the wagmi integration.
 *    Use `options.solana.store` to enable.
 *
 * 2. **Explicit tracking mode**: Provides manual tracking methods
 *    (trackTransaction, trackSignature, etc.) for any wallet standard.
 *    Works with @solana/wallet-adapter, wallet-standard, and @solana/kit.
 *
 * @deprecated The wallet-adapter wrapping approach (setWallet with ISolanaAdapter/SolanaWalletContext)
 * is deprecated. Use store mode or explicit tracking instead.
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { logger } from "../logger";
import { SolanaAdapter } from "./SolanaAdapter";
import { SolanaStoreHandler } from "./SolanaStoreHandler";
import {
  ISolanaAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaCluster,
  SolanaOptions,
} from "./types";
import { SolanaClientStore } from "./storeTypes";

export class SolanaManager {
  private handler?: SolanaAdapter;
  private storeHandler?: SolanaStoreHandler;
  private pendingConnection?: SolanaConnection;
  private pendingCluster?: SolanaCluster;

  constructor(
    private formo: FormoAnalytics,
    options?: SolanaOptions
  ) {
    // Store mode: subscribe to framework-kit's zustand store for autocapture
    if (options?.store) {
      logger.info("SolanaManager: Initializing store-based Solana tracking");
      this.storeHandler = new SolanaStoreHandler(formo, options.store, {
        cluster: options.cluster,
      });
    } else if (options?.wallet) {
      logger.info("SolanaManager: Initializing Solana wallet tracking");
      this.handler = new SolanaAdapter(formo, {
        wallet: options.wallet,
        connection: options.connection,
        cluster: options.cluster,
      });
    } else if (options) {
      // Store pending values for when wallet is set later
      this.pendingConnection = options.connection;
      this.pendingCluster = options.cluster;
    }
  }

  get adapter(): SolanaAdapter | undefined {
    return this.handler;
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
    // Clean up any existing handlers
    this.storeHandler?.cleanup();
    this.handler?.cleanup();
    this.handler = undefined;

    this.storeHandler = new SolanaStoreHandler(this.formo, store, {
      cluster: options?.cluster || this.pendingCluster,
    });
    this.pendingConnection = undefined;
    this.pendingCluster = undefined;
  }

  /**
   * @deprecated Use setStore() for automatic tracking, or use the explicit tracking
   * methods (trackTransaction, trackSignature, trackConnect, trackDisconnect) instead.
   */
  setWallet(
    wallet: ISolanaAdapter | SolanaWalletContext | null
  ): void {
    // Don't set up adapter if store mode is active
    if (this.storeHandler) {
      logger.warn("SolanaManager: setWallet() ignored — store mode is active. Use setStore() or explicit tracking methods.");
      return;
    }

    if (this.handler) {
      this.handler.setWallet(wallet);
    } else if (wallet) {
      logger.info("SolanaManager: Initializing Solana wallet tracking (lazy)");
      this.handler = new SolanaAdapter(this.formo, {
        wallet,
        connection: this.pendingConnection,
        cluster: this.pendingCluster,
      });
      this.pendingConnection = undefined;
      this.pendingCluster = undefined;
    }
  }

  setConnection(connection: SolanaConnection | null): void {
    if (this.handler) {
      this.handler.setConnection(connection);
    } else {
      this.pendingConnection = connection ?? undefined;
    }
  }

  setCluster(cluster: SolanaCluster): void {
    if (this.storeHandler) {
      this.storeHandler.setCluster(cluster);
    } else if (this.handler) {
      this.handler.setCluster(cluster);
    } else {
      this.pendingCluster = cluster;
    }
  }

  /**
   * @deprecated Use setStore() for automatic tracking, or use the explicit tracking methods.
   */
  syncWalletState(): void {
    this.handler?.syncWalletState();
  }

  /**
   * Track a transaction after it has been sent.
   * Emits BROADCASTED event and starts polling for confirmation.
   *
   * Note: In store mode, transactions are tracked automatically.
   * This method is for explicit tracking when not using store mode.
   *
   * @param signature - The transaction signature returned by sendTransaction
   * @param connection - Optional connection override for polling
   */
  trackTransaction(signature: string, connection?: SolanaConnection): void {
    if (this.warnIfStoreMode("trackTransaction")) return;
    this.ensureHandler();
    this.handler!.trackTransaction(signature, connection);
  }

  /**
   * Track a transaction lifecycle event explicitly.
   *
   * @param status - The transaction status
   * @param options - Optional transaction details
   */
  trackTransactionStatus(
    status: "started" | "rejected" | "broadcasted" | "confirmed" | "reverted",
    options?: { transactionHash?: string }
  ): void {
    if (this.warnIfStoreMode("trackTransactionStatus")) return;
    this.ensureHandler();
    this.handler!.trackTransactionStatus(status, options);
  }

  /**
   * Track a signature (signMessage / signTransaction) event.
   *
   * @param status - The signature status
   * @param options - Details about the signature request
   */
  trackSignature(
    status: "requested" | "confirmed" | "rejected",
    options?: { message?: string; signatureHash?: string }
  ): void {
    if (this.warnIfStoreMode("trackSignature")) return;
    this.ensureHandler();
    this.handler!.trackSignature(status, options);
  }

  /**
   * Explicitly track a wallet connection.
   * Use when not using store mode or wallet-adapter.
   *
   * Note: In store mode, connections are tracked automatically.
   *
   * @param address - The connected wallet address (Base58)
   * @param options - Optional wallet metadata
   */
  trackConnect(address: string, options?: { walletName?: string }): void {
    if (this.warnIfStoreMode("trackConnect")) return;
    this.ensureHandler();
    this.handler!.trackConnect(address, options);
  }

  /**
   * Explicitly track a wallet disconnection.
   *
   * Note: In store mode, disconnections are tracked automatically.
   *
   * @param address - Optional address override
   */
  trackDisconnect(address?: string): void {
    if (this.warnIfStoreMode("trackDisconnect")) return;
    this.ensureHandler();
    this.handler!.trackDisconnect(address);
  }

  cleanup(): void {
    this.storeHandler?.cleanup();
    this.storeHandler = undefined;
    this.handler?.cleanup();
    this.handler = undefined;
  }

  /**
   * Guard against calling explicit tracking methods in store mode.
   * Returns true (caller should return) if store mode is active.
   */
  private warnIfStoreMode(method: string): boolean {
    if (this.storeHandler) {
      logger.warn(
        `SolanaManager: ${method}() ignored — store mode is active. ` +
        "Events are tracked automatically via the store subscription."
      );
      return true;
    }
    return false;
  }

  /**
   * Ensure handler exists (lazy-init without a wallet for explicit tracking).
   */
  private ensureHandler(): void {
    if (!this.handler) {
      this.handler = new SolanaAdapter(this.formo, {
        connection: this.pendingConnection,
        cluster: this.pendingCluster,
      });
      this.pendingConnection = undefined;
      this.pendingCluster = undefined;
    }
  }
}
