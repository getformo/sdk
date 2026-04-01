/**
 * SolanaStoreHandler
 *
 * Handles wallet event tracking by subscribing to framework-kit's zustand store.
 * This provides automatic event capture (autocapture) for Solana wallets without
 * wrapping any wallet methods — similar to how WagmiEventHandler subscribes to
 * TanStack Query's mutation/query caches.
 *
 * Subscribes to:
 * - `state.wallet` — connect/disconnect events
 * - `state.transactions` — transaction lifecycle events (sending → confirmed/failed)
 *
 * @see https://github.com/solana-foundation/framework-kit
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { TransactionStatus } from "../types/events";
import { logger } from "../logger";
import {
  SolanaClientStore,
  SolanaClientState,
  SolanaTransactionRecord,
  SolanaWalletStatus,
} from "./storeTypes";
import { SOLANA_CHAIN_IDS, SolanaCluster, UnsubscribeFn } from "./types";
import { isBlockedSolanaAddress } from "./address";

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
      set.delete(entries[i]);
    }
  }
}

export class SolanaStoreHandler {
  private formo: FormoAnalytics;
  private store: SolanaClientStore;
  private unsubscribers: UnsubscribeFn[] = [];
  private cluster: SolanaCluster;
  private chainId: number;

  /**
   * Track last known wallet status to detect transitions.
   */
  private lastWalletStatus: SolanaWalletStatus["status"] = "disconnected";
  private lastAddress?: string;
  private lastChainId?: number;

  /**
   * Track processed transaction state changes to prevent duplicate events.
   * Key format: `${signature}:${status}`
   */
  private processedTransactions = new Set<string>();

  /**
   * Track transactions we've emitted STARTED for (status was "sending").
   * Ensures we only emit STARTED once per transaction key.
   */
  private startedTransactions = new Set<string>();

  constructor(
    formoAnalytics: FormoAnalytics,
    store: SolanaClientStore,
    options?: { cluster?: SolanaCluster }
  ) {
    this.formo = formoAnalytics;
    this.store = store;
    this.cluster = options?.cluster || "mainnet-beta";
    this.chainId = SOLANA_CHAIN_IDS[this.cluster];

    logger.info("SolanaStoreHandler: Initializing framework-kit store integration", {
      cluster: this.cluster,
      chainId: this.chainId,
    });

    this.setupWalletSubscription();
    this.setupTransactionSubscription();

    // Check initial wallet state
    this.checkInitialWalletState();
  }

  /**
   * Update the cluster/network.
   */
  public setCluster(cluster: SolanaCluster): void {
    const previousCluster = this.cluster;
    this.cluster = cluster;
    this.chainId = SOLANA_CHAIN_IDS[cluster];

    if (previousCluster !== cluster && this.lastAddress) {
      this.lastChainId = this.chainId;

      if (this.formo.isAutocaptureEnabled("chain")) {
        this.formo.chain({
          chainId: this.chainId,
          address: this.lastAddress,
        }).catch((error) => {
          logger.error("SolanaStoreHandler: Error emitting chain event", error);
        });
      }
    }
  }

  /**
   * Get the current chain ID.
   */
  public getChainId(): number {
    return this.chainId;
  }

  // ============================================================
  // Wallet Subscription
  // ============================================================

  private setupWalletSubscription(): void {
    // Subscribe to wallet status changes
    const unsubscribe = this.store.subscribe(
      (state: SolanaClientState) => state.wallet,
      (wallet, prevWallet) => {
        this.handleWalletChange(wallet, prevWallet);
      }
    );
    this.unsubscribers.push(unsubscribe);

    logger.info("SolanaStoreHandler: Wallet subscription set up");
  }

  private checkInitialWalletState(): void {
    const state = this.store.getState();
    const wallet = state.wallet;

    if (wallet.status === "connected") {
      const address = wallet.session.account.address;
      if (address && !isBlockedSolanaAddress(address)) {
        this.lastWalletStatus = "connected";
        this.lastAddress = address;
        this.lastChainId = this.chainId;

        logger.info("SolanaStoreHandler: Already connected on initialization", {
          address,
          chainId: this.chainId,
        });

        if (this.formo.isAutocaptureEnabled("connect")) {
          const connectorName = wallet.session.connector?.name || "Unknown Solana Wallet";
          this.formo.connect(
            { chainId: this.chainId, address },
            {
              providerName: connectorName,
              rdns: `sol.wallet.${connectorName.toLowerCase().replace(/\s+/g, "")}`,
            }
          ).catch((error) => {
            logger.error("SolanaStoreHandler: Error emitting initial connect", error);
          });
        }
      }
    }

    this.lastWalletStatus = wallet.status;
  }

  private handleWalletChange(
    wallet: SolanaWalletStatus,
    prevWallet: SolanaWalletStatus
  ): void {
    // connected → disconnected or connected → error
    if (
      prevWallet.status === "connected" &&
      (wallet.status === "disconnected" || wallet.status === "error")
    ) {
      this.handleDisconnect();
    }

    // * → connected
    if (wallet.status === "connected" && prevWallet.status !== "connected") {
      this.handleConnect(wallet);
    }

    this.lastWalletStatus = wallet.status;
  }

  private handleConnect(wallet: Extract<SolanaWalletStatus, { status: "connected" }>): void {
    const address = wallet.session.account.address;
    if (!address || isBlockedSolanaAddress(address)) {
      return;
    }

    this.lastAddress = address;
    this.lastChainId = this.chainId;

    logger.info("SolanaStoreHandler: Wallet connected", {
      address,
      chainId: this.chainId,
      connector: wallet.connectorId,
    });

    if (this.formo.isAutocaptureEnabled("connect")) {
      const connectorName = wallet.session.connector?.name || wallet.connectorId;
      this.formo.connect(
        { chainId: this.chainId, address },
        {
          providerName: connectorName,
          rdns: `sol.wallet.${connectorName.toLowerCase().replace(/\s+/g, "")}`,
        }
      ).catch((error) => {
        logger.error("SolanaStoreHandler: Error emitting connect", error);
      });
    }
  }

  private handleDisconnect(): void {
    if (!this.lastAddress) {
      return;
    }

    logger.info("SolanaStoreHandler: Wallet disconnected", {
      address: this.lastAddress,
      chainId: this.lastChainId,
    });

    if (this.formo.isAutocaptureEnabled("disconnect")) {
      this.formo.disconnect({
        chainId: this.lastChainId,
        address: this.lastAddress,
      }).catch((error) => {
        logger.error("SolanaStoreHandler: Error emitting disconnect", error);
      });
    }

    this.lastAddress = undefined;
    this.lastChainId = undefined;
  }

  // ============================================================
  // Transaction Subscription
  // ============================================================

  private setupTransactionSubscription(): void {
    const unsubscribe = this.store.subscribe(
      (state: SolanaClientState) => state.transactions,
      (transactions, prevTransactions) => {
        this.handleTransactionChanges(transactions, prevTransactions);
      }
    );
    this.unsubscribers.push(unsubscribe);

    logger.info("SolanaStoreHandler: Transaction subscription set up");
  }

  private handleTransactionChanges(
    transactions: Record<string, SolanaTransactionRecord>,
    prevTransactions: Record<string, SolanaTransactionRecord>
  ): void {
    const address = this.lastAddress;
    if (!address) {
      return;
    }

    // Check each transaction for status changes
    for (const [key, tx] of Object.entries(transactions)) {
      const prevTx = prevTransactions[key];

      // Skip if status hasn't changed
      if (prevTx && prevTx.status === tx.status) {
        continue;
      }

      this.handleTransactionStatusChange(key, tx, prevTx, address);
    }
  }

  private handleTransactionStatusChange(
    key: string,
    tx: SolanaTransactionRecord,
    prevTx: SolanaTransactionRecord | undefined,
    address: string
  ): void {
    const chainId = this.chainId;
    const dedupeKey = `${key}:${tx.status}`;

    // Deduplicate
    if (this.processedTransactions.has(dedupeKey)) {
      return;
    }
    this.processedTransactions.add(dedupeKey);
    cleanupOldEntries(this.processedTransactions);

    if (!this.formo.isAutocaptureEnabled("transaction")) {
      return;
    }

    switch (tx.status) {
      case "sending": {
        // Emit STARTED when transaction enters "sending" state
        if (!this.startedTransactions.has(key)) {
          this.startedTransactions.add(key);
          cleanupOldEntries(this.startedTransactions);

          this.formo.transaction({
            status: TransactionStatus.STARTED,
            chainId,
            address,
          });
        }
        break;
      }

      case "waiting": {
        // "waiting" means the tx was sent and we have a signature — emit BROADCASTED
        const signature = tx.signature;
        if (signature) {
          this.formo.transaction({
            status: TransactionStatus.BROADCASTED,
            chainId,
            address,
            transactionHash: signature,
          });
        }
        break;
      }

      case "confirmed": {
        const signature = tx.signature;
        logger.info("SolanaStoreHandler: Transaction confirmed", {
          key,
          signature,
        });

        this.formo.transaction({
          status: TransactionStatus.CONFIRMED,
          chainId,
          address,
          ...(signature && { transactionHash: signature }),
        });
        break;
      }

      case "failed": {
        const signature = tx.signature;
        const prevStatus = prevTx?.status;

        // If it failed before being sent (rejected by user or build error), emit REJECTED
        // If it failed after being sent (on-chain failure), emit REVERTED
        const status =
          prevStatus === "sending" || prevStatus === "waiting"
            ? TransactionStatus.REVERTED
            : TransactionStatus.REJECTED;

        logger.info("SolanaStoreHandler: Transaction failed", {
          key,
          signature,
          status,
          prevStatus,
        });

        this.formo.transaction({
          status,
          chainId,
          address,
          ...(signature && { transactionHash: signature }),
        });
        break;
      }

      // "idle" — no event needed
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  public cleanup(): void {
    logger.debug("SolanaStoreHandler: Cleaning up");

    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.error("SolanaStoreHandler: Error during cleanup", error);
      }
    }
    this.unsubscribers = [];
    this.processedTransactions.clear();
    this.startedTransactions.clear();
    this.lastAddress = undefined;
    this.lastChainId = undefined;

    logger.debug("SolanaStoreHandler: Cleanup complete");
  }
}
