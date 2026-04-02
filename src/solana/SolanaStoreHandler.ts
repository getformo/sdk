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
import { SignatureStatus, TransactionStatus } from "../types/events";
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

  /**
   * Per-transaction sender address captured at STARTED time.
   * Ensures terminal events (confirmed/failed) are attributed correctly
   * even if the wallet disconnects before the transaction settles.
   */
  private transactionSenders = new Map<string, { address: string; chainId: number }>();

  constructor(
    formoAnalytics: FormoAnalytics,
    store: SolanaClientStore,
    options?: { cluster?: SolanaCluster }
  ) {
    this.formo = formoAnalytics;
    this.store = store;
    this.cluster = options?.cluster || this.detectClusterFromStore(store) || "mainnet-beta";
    this.chainId = SOLANA_CHAIN_IDS[this.cluster];

    logger.info("SolanaStoreHandler: Initializing framework-kit store integration", {
      cluster: this.cluster,
      chainId: this.chainId,
    });

    this.setupWalletSubscription();
    this.setupTransactionSubscription();
    this.setupClusterSubscription();

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

  /**
   * Resolve the current chainId from the live store state.
   * This ensures correctness when wallet and cluster change in the same tick
   * (the cluster subscription may not have fired yet).
   */
  private resolveCurrentChainId(): number {
    const detected = this.detectClusterFromStore(this.store);
    if (detected) {
      this.cluster = detected;
      this.chainId = SOLANA_CHAIN_IDS[detected];
    }
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
    // connected → any other state (disconnected, error, connecting)
    if (
      prevWallet.status === "connected" &&
      wallet.status !== "connected"
    ) {
      this.handleDisconnect();
    }

    // * → connected (new connection)
    if (wallet.status === "connected" && prevWallet.status !== "connected") {
      this.handleConnect(wallet);
    } else if (
      wallet.status === "connected" &&
      prevWallet.status === "connected"
    ) {
      // connected → connected: check for account switch OR connector change
      const addressChanged =
        wallet.session.account.address !== prevWallet.session.account.address;
      const connectorChanged =
        wallet.connectorId !== prevWallet.connectorId;

      if (addressChanged || connectorChanged) {
        this.handleDisconnect();
        this.handleConnect(wallet);
      }
    }

    this.lastWalletStatus = wallet.status;
  }

  private handleConnect(wallet: Extract<SolanaWalletStatus, { status: "connected" }>): void {
    const address = wallet.session.account.address;
    if (!address || isBlockedSolanaAddress(address)) {
      return;
    }

    // Resolve chainId from live store state so batched wallet+cluster
    // updates use the correct network even if the cluster subscription
    // hasn't fired yet.
    const chainId = this.resolveCurrentChainId();

    this.lastAddress = address;
    this.lastChainId = chainId;

    logger.info("SolanaStoreHandler: Wallet connected", {
      address,
      chainId,
      connector: wallet.connectorId,
    });

    if (this.formo.isAutocaptureEnabled("connect")) {
      const connectorName = wallet.session.connector?.name || wallet.connectorId;
      this.formo.connect(
        { chainId, address },
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
  // Cluster Subscription
  // ============================================================

  private setupClusterSubscription(): void {
    const unsubscribe = this.store.subscribe(
      (state: SolanaClientState) => state.cluster.endpoint,
      (endpoint, prevEndpoint) => {
        if (endpoint !== prevEndpoint) {
          this.handleClusterChange(endpoint);
        }
      }
    );
    this.unsubscribers.push(unsubscribe);

    logger.info("SolanaStoreHandler: Cluster subscription set up");
  }

  private handleClusterChange(endpoint: string): void {
    const detected = this.detectClusterFromEndpoint(endpoint);
    if (!detected) {
      return;
    }

    const previousCluster = this.cluster;
    if (detected === previousCluster) {
      return;
    }

    this.cluster = detected;
    this.chainId = SOLANA_CHAIN_IDS[detected];

    logger.info("SolanaStoreHandler: Cluster changed", {
      from: previousCluster,
      to: detected,
      chainId: this.chainId,
    });

    if (this.lastAddress && this.formo.isAutocaptureEnabled("chain")) {
      this.lastChainId = this.chainId;
      this.formo.chain({
        chainId: this.chainId,
        address: this.lastAddress,
      }).catch((error) => {
        logger.error("SolanaStoreHandler: Error emitting chain event", error);
      });
    }
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
    // Check each transaction for status changes
    for (const [key, tx] of Object.entries(transactions)) {
      const prevTx = prevTransactions[key];

      // Skip if status hasn't changed
      if (prevTx && prevTx.status === tx.status) {
        continue;
      }

      // For new transactions (sending), use current address.
      // For terminal states, fall back to the address captured at STARTED time.
      const address = this.lastAddress || this.transactionSenders.get(key)?.address;
      if (!address) {
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

          // Capture sender for this transaction so terminal events are attributed
          // correctly even if the wallet disconnects before the tx settles.
          this.transactionSenders.set(key, { address, chainId });

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
          // Ensure sender is captured (in case we missed "sending")
          if (!this.transactionSenders.has(key)) {
            this.transactionSenders.set(key, { address, chainId });
          }
          const sender = this.transactionSenders.get(key)!;
          this.formo.transaction({
            status: TransactionStatus.BROADCASTED,
            chainId: sender.chainId,
            address: sender.address,
            transactionHash: signature,
          });
        }
        break;
      }

      case "confirmed": {
        const sender = this.transactionSenders.get(key);
        const txAddress = sender?.address || address;
        const txChainId = sender?.chainId || chainId;
        const signature = tx.signature;
        logger.info("SolanaStoreHandler: Transaction confirmed", {
          key,
          signature,
        });

        this.formo.transaction({
          status: TransactionStatus.CONFIRMED,
          chainId: txChainId,
          address: txAddress,
          ...(signature && { transactionHash: signature }),
        });

        this.transactionSenders.delete(key);
        break;
      }

      case "failed": {
        const sender = this.transactionSenders.get(key);
        const txAddress = sender?.address || address;
        const txChainId = sender?.chainId || chainId;
        const signature = tx.signature;
        const prevStatus = prevTx?.status;

        // If it failed after being sent and confirmed as failed on-chain, emit REVERTED.
        // Otherwise (rejected by user, build error, RPC rejection), emit REJECTED.
        const status =
          prevStatus === "waiting"
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
          chainId: txChainId,
          address: txAddress,
          ...(signature && { transactionHash: signature }),
        });

        this.transactionSenders.delete(key);
        break;
      }

      // "idle" — no event needed
    }
  }

  // ============================================================
  // Explicit Signature Tracking (no store state for signatures)
  // ============================================================

  /**
   * Track a signature event. Framework-kit's store does not track signMessage
   * or signTransaction state, so this must be called explicitly.
   * Uses the store's current wallet address for attribution.
   */
  public trackSignature(
    status: "requested" | "confirmed" | "rejected",
    options?: { message?: string; signatureHash?: string }
  ): void {
    const address = this.lastAddress;
    if (!address || !this.formo.isAutocaptureEnabled("signature")) {
      return;
    }

    const statusMap: Record<string, SignatureStatus> = {
      requested: SignatureStatus.REQUESTED,
      confirmed: SignatureStatus.CONFIRMED,
      rejected: SignatureStatus.REJECTED,
    };

    this.formo.signature({
      status: statusMap[status],
      chainId: this.chainId,
      address,
      message: options?.message || "",
      ...(options?.signatureHash && { signatureHash: options.signatureHash }),
    });
  }

  /**
   * Get the current tracked address (if connected).
   */
  public getCurrentAddress(): string | undefined {
    return this.lastAddress;
  }

  // ============================================================
  // Cluster Detection
  // ============================================================

  /**
   * Attempt to detect the Solana cluster from the store's endpoint URL.
   */
  private detectClusterFromStore(store: SolanaClientStore): SolanaCluster | null {
    try {
      const endpoint = store.getState().cluster.endpoint;
      return this.detectClusterFromEndpoint(endpoint);
    } catch {
      return null;
    }
  }

  /**
   * Detect cluster from an RPC endpoint URL.
   */
  private detectClusterFromEndpoint(endpoint: string | undefined): SolanaCluster | null {
    if (!endpoint) return null;
    const lower = endpoint.toLowerCase();
    if (lower.includes("devnet")) return "devnet";
    if (lower.includes("testnet")) return "testnet";
    if (lower.includes("localhost") || lower.includes("127.0.0.1")) return "localnet";
    if (lower.includes("mainnet")) return "mainnet-beta";
    return null;
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
    this.transactionSenders.clear();
    this.lastAddress = undefined;
    this.lastChainId = undefined;

    logger.debug("SolanaStoreHandler: Cleanup complete");
  }
}
