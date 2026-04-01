/**
 * SolanaManager
 *
 * Manages the lifecycle of the SolanaAdapter, handling lazy initialization
 * and pending configuration. This keeps Solana-specific lifecycle logic out of
 * the main FormoAnalytics class.
 *
 * Provides explicit tracking methods (trackTransaction, trackSignature, etc.)
 * that do not wrap or proxy wallet methods.
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { logger } from "../logger";
import { SolanaAdapter } from "./SolanaAdapter";
import {
  ISolanaAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaCluster,
  SolanaOptions,
} from "./types";

export class SolanaManager {
  private handler?: SolanaAdapter;
  private pendingConnection?: SolanaConnection;
  private pendingCluster?: SolanaCluster;

  constructor(
    private formo: FormoAnalytics,
    options?: SolanaOptions
  ) {
    if (options?.wallet) {
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

  setWallet(
    wallet: ISolanaAdapter | SolanaWalletContext | null
  ): void {
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
    if (this.handler) {
      this.handler.setCluster(cluster);
    } else {
      this.pendingCluster = cluster;
    }
  }

  syncWalletState(): void {
    this.handler?.syncWalletState();
  }

  /**
   * Track a transaction after it has been sent.
   * Emits BROADCASTED event and starts polling for confirmation.
   *
   * @param signature - The transaction signature returned by sendTransaction
   * @param connection - Optional connection override for polling
   */
  trackTransaction(signature: string, connection?: SolanaConnection): void {
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
    this.ensureHandler();
    this.handler!.trackSignature(status, options);
  }

  /**
   * Explicitly track a wallet connection.
   * Use when not using wallet-adapter (e.g., @solana/kit or wallet-standard).
   *
   * @param address - The connected wallet address (Base58)
   * @param options - Optional wallet metadata
   */
  trackConnect(address: string, options?: { walletName?: string }): void {
    this.ensureHandler();
    this.handler!.trackConnect(address, options);
  }

  /**
   * Explicitly track a wallet disconnection.
   *
   * @param address - Optional address override
   */
  trackDisconnect(address?: string): void {
    this.ensureHandler();
    this.handler!.trackDisconnect(address);
  }

  cleanup(): void {
    this.handler?.cleanup();
    this.handler = undefined;
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
