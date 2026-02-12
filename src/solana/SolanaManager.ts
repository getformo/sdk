/**
 * SolanaManager
 *
 * Manages the lifecycle of the SolanaAdapter, handling lazy initialization
 * and pending configuration. This keeps Solana-specific lifecycle logic out of
 * the main FormoAnalytics class.
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

  cleanup(): void {
    this.handler?.cleanup();
    this.handler = undefined;
  }
}
