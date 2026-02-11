/**
 * SolanaWalletAdapterHandler
 *
 * Handles wallet event tracking by hooking into Solana Wallet Adapter events.
 * This provides integration with the @solana/wallet-adapter ecosystem.
 *
 * @see https://github.com/anza-xyz/wallet-adapter
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { SignatureStatus, TransactionStatus } from "../types/events";
import { logger } from "../logger";
import {
  SolanaWalletAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaCluster,
  SolanaTrackingState,
  SolanaPublicKey,
  TransactionSignature,
  UnsubscribeFn,
  SOLANA_CHAIN_IDS,
  isSolanaWalletContext,
  isSolanaWalletAdapter,
  SolanaTransaction,
  SendTransactionOptions,
} from "./types";
import {
  isBlockedSolanaAddress,
  publicKeyToAddress,
} from "./address";

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

/**
 * Convert a Uint8Array to a hex string (browser-compatible alternative to Buffer.from().toString('hex'))
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Safely decode a Uint8Array message to string.
 * Falls back to hex representation if TextDecoder is unavailable (some Node environments).
 */
function safeDecodeMessage(message: Uint8Array): string {
  try {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(message);
    }
    // Fallback for Node environments without TextDecoder global
    if (typeof Buffer !== "undefined") {
      return Buffer.from(message).toString("utf-8");
    }
    // Last resort: hex representation
    return `0x${uint8ArrayToHex(message)}`;
  } catch {
    return `0x${uint8ArrayToHex(message)}`;
  }
}

export class SolanaWalletAdapterHandler {
  private formo: FormoAnalytics;
  private wallet: SolanaWalletAdapter | SolanaWalletContext | null = null;
  private connection: SolanaConnection | null = null;
  private cluster: SolanaCluster;
  private chainId: number;
  private unsubscribers: UnsubscribeFn[] = [];
  private trackingState: SolanaTrackingState = {
    isProcessing: false,
  };

  /**
   * Track processed signatures to prevent duplicate event emissions
   */
  private processedSignatures = new Set<string>();

  /**
   * Store pending transaction details for confirmation tracking
   * Key: transaction signature, Value: transaction details
   */
  private pendingTransactions = new Map<
    string,
    {
      address: string;
      startTime: number;
    }
  >();

  /**
   * Original adapter methods that we wrap for tracking
   */
  private originalAdapterSendTransaction?: SolanaWalletAdapter["sendTransaction"];
  private originalAdapterSignMessage?: SolanaWalletAdapter["signMessage"];
  private originalAdapterSignTransaction?: SolanaWalletAdapter["signTransaction"];

  /**
   * Reference to the wrapped adapter (to restore methods on cleanup)
   */
  private wrappedAdapter?: SolanaWalletAdapter;

  /**
   * Reference to the adapter we bound event listeners to (for context wallets).
   * Used to detect when context.wallet changes and rebind listeners.
   */
  private currentBoundAdapter?: SolanaWalletAdapter;

  /**
   * Track active polling timeout IDs for cleanup
   */
  private pollingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Flag to prevent new polls after cleanup is initiated
   */
  private isCleanedUp = false;

  constructor(
    formoAnalytics: FormoAnalytics,
    options: {
      wallet?: SolanaWalletAdapter | SolanaWalletContext;
      connection?: SolanaConnection;
      cluster?: SolanaCluster;
    }
  ) {
    this.formo = formoAnalytics;
    this.wallet = options.wallet || null;
    this.connection = options.connection || null;
    this.cluster = options.cluster || "mainnet-beta";
    this.chainId = SOLANA_CHAIN_IDS[this.cluster];

    logger.info("SolanaWalletAdapterHandler: Initializing Solana integration", {
      cluster: this.cluster,
      chainId: this.chainId,
      hasWallet: !!this.wallet,
      hasConnection: !!this.connection,
    });

    if (this.wallet) {
      this.setupWalletListeners();
    }
  }

  /**
   * Restore original methods on the wrapped adapter
   */
  private restoreOriginalMethods(): void {
    // Restore adapter methods
    if (this.wrappedAdapter) {
      if (this.originalAdapterSendTransaction) {
        this.wrappedAdapter.sendTransaction = this.originalAdapterSendTransaction;
      }
      if (this.originalAdapterSignMessage) {
        this.wrappedAdapter.signMessage = this.originalAdapterSignMessage;
      }
      if (this.originalAdapterSignTransaction) {
        this.wrappedAdapter.signTransaction = this.originalAdapterSignTransaction;
      }
      this.wrappedAdapter = undefined;
    }

    // Clear original method references
    this.originalAdapterSendTransaction = undefined;
    this.originalAdapterSignMessage = undefined;
    this.originalAdapterSignTransaction = undefined;
  }

  /**
   * Update the wallet instance (useful for React context updates)
   */
  public setWallet(
    wallet: SolanaWalletAdapter | SolanaWalletContext | null
  ): void {
    // Restore original methods on previous wallet before cleaning up
    this.restoreOriginalMethods();

    // Clean up previous wallet listeners
    this.cleanupWalletListeners();

    this.wallet = wallet;

    if (this.wallet) {
      // Reset cleanup flag when setting a new wallet to enable polling
      this.isCleanedUp = false;
      this.setupWalletListeners();
    }
  }

  /**
   * Check if the wallet adapter has changed (for context-based wallets) and rebind if needed.
   * Call this in React effects when you know the wallet context may have changed but the
   * context object reference stayed the same (e.g., user switched wallets in the wallet selector).
   *
   * This ensures connect/disconnect events from the new wallet are properly tracked without
   * waiting for the next transaction or signature call.
   *
   * @example
   * ```tsx
   * const wallet = useWallet();
   * useEffect(() => {
   *   formo.syncSolanaWalletState();
   * }, [wallet.wallet]); // Trigger when inner wallet changes
   * ```
   */
  public syncWalletState(): void {
    this.checkAndRebindContextAdapter();
  }

  /**
   * Update the connection instance
   */
  public setConnection(connection: SolanaConnection | null): void {
    this.connection = connection;
  }

  /**
   * Update the cluster/network
   */
  public setCluster(cluster: SolanaCluster): void {
    const previousCluster = this.cluster;
    this.cluster = cluster;
    this.chainId = SOLANA_CHAIN_IDS[cluster];

    // Update trackingState and emit chain event if connected and cluster changed
    if (previousCluster !== cluster && this.trackingState.lastAddress) {
      // Always update trackingState to keep lastChainId in sync for future disconnect events
      this.trackingState.lastChainId = this.chainId;

      if (this.formo.isAutocaptureEnabled("chain")) {
        // Use internal method to avoid corrupting shared EVM wallet state
        this.formo.trackChainEventOnly({
          chainId: this.chainId,
          address: this.trackingState.lastAddress,
        }).catch((error) => {
          logger.error("SolanaWalletAdapterHandler: Error emitting chain event", error);
        });
      }
    }
  }

  /**
   * Get the current chain ID
   */
  public getChainId(): number {
    return this.chainId;
  }

  /**
   * Set up listeners for wallet events
   */
  private setupWalletListeners(): void {
    if (!this.wallet) {
      return;
    }

    logger.info("SolanaWalletAdapterHandler: Setting up wallet listeners");

    // Handle both WalletContext (from useWallet) and direct WalletAdapter
    if (isSolanaWalletContext(this.wallet)) {
      this.setupContextListeners(this.wallet);
    } else if (isSolanaWalletAdapter(this.wallet)) {
      this.setupAdapterListeners(this.wallet);
    }

    // Check if already connected
    this.checkInitialConnection().catch((error) => {
      logger.error(
        "SolanaWalletAdapterHandler: Error checking initial connection",
        error
      );
    });

    logger.info(
      "SolanaWalletAdapterHandler: Wallet listeners set up successfully"
    );
  }

  /**
   * Set up listeners for a wallet context (useWallet)
   */
  private setupContextListeners(context: SolanaWalletContext): void {
    // The wallet-adapter-react useWallet() returns wallet as { adapter, readyState },
    // so we need to extract the actual adapter which has .on()/.off() methods.
    //
    // IMPORTANT: We wrap methods on the adapter (not the context) because
    // useWallet() returns a new object reference on each render. Components
    // that call useWallet() independently get their own sendTransaction/signMessage
    // callbacks that delegate to adapter.sendTransaction/adapter.signMessage.
    // Wrapping the context object only mutates the FormoProvider's reference,
    // not what other components receive from useWallet().
    const adapter = this.getAdapterFromContext(context);
    if (adapter) {
      this.setupAdapterEventListenersOnly(adapter);
      // Wrap adapter methods so all components using useWallet() are tracked
      this.wrapAdapterMethods(adapter);
    }
  }

  /**
   * Check if the adapter inside a wallet context has changed (e.g., user switched wallets).
   * If so, rebind event listeners and rewrap methods on the new adapter.
   * This handles the case where context.wallet changes but the context object reference stays the same.
   */
  private checkAndRebindContextAdapter(): void {
    if (!this.wallet || !isSolanaWalletContext(this.wallet)) {
      return;
    }

    const currentAdapter = this.getAdapterFromContext(this.wallet);

    // If adapter changed, rebind listeners and rewrap methods
    if (currentAdapter !== this.currentBoundAdapter) {
      logger.info(
        "SolanaWalletAdapterHandler: Detected wallet adapter change, rebinding"
      );

      // Restore methods on old adapter and clean up listeners
      this.restoreOriginalMethods();
      this.cleanupAdapterListenersOnly();

      // Set up on new adapter
      if (currentAdapter) {
        this.setupAdapterEventListenersOnly(currentAdapter);
        this.wrapAdapterMethods(currentAdapter);

        // Check if new adapter is already connected
        this.checkInitialConnection().catch((error) => {
          logger.error(
            "SolanaWalletAdapterHandler: Error checking initial connection after adapter change",
            error
          );
        });
      } else {
        // No adapter means disconnected
        this.currentBoundAdapter = undefined;
        if (this.trackingState.lastAddress) {
          this.handleDisconnect();
        }
      }
    }
  }

  /**
   * Clean up only adapter event listeners (not the full cleanup)
   */
  private cleanupAdapterListenersOnly(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.error(
          "SolanaWalletAdapterHandler: Error cleaning up adapter listener",
          error
        );
      }
    }
    this.unsubscribers = [];
    this.currentBoundAdapter = undefined;
  }

  /**
   * Register a listener on an adapter and track its unsubscriber
   */
  private registerAdapterListener(
    adapter: SolanaWalletAdapter,
    event: string,
    handler: (...args: unknown[]) => void
  ): void {
    adapter.on(event as "connect", handler as () => void);
    this.unsubscribers.push(() => adapter.off(event as "connect", handler as () => void));
  }

  /**
   * Set up event listeners on an adapter (connect/disconnect events)
   */
  private setupAdapterEventListenersOnly(adapter: SolanaWalletAdapter): void {
    this.currentBoundAdapter = adapter;

    this.registerAdapterListener(adapter, "connect", (publicKey: unknown) =>
      this.handleConnect(publicKey as SolanaPublicKey)
    );
    this.registerAdapterListener(adapter, "disconnect", () =>
      this.handleDisconnect()
    );
    this.registerAdapterListener(adapter, "error", (error: unknown) =>
      logger.error("SolanaWalletAdapterHandler: Wallet error", error)
    );
  }

  /**
   * Set up listeners for a direct wallet adapter
   */
  private setupAdapterListeners(adapter: SolanaWalletAdapter): void {
    this.setupAdapterEventListenersOnly(adapter);
    this.wrapAdapterMethods(adapter);
  }

  /**
   * Wrap wallet adapter methods for transaction/signature tracking
   */
  private wrapAdapterMethods(adapter: SolanaWalletAdapter): void {
    // Guard against double-wrapping the same adapter (e.g., React re-renders)
    // If we already wrapped this adapter, skip to prevent capturing wrapped methods as originals
    if (this.wrappedAdapter === adapter) {
      logger.debug(
        "SolanaWalletAdapterHandler: Adapter already wrapped, skipping"
      );
      return;
    }

    // Store reference to adapter for cleanup
    this.wrappedAdapter = adapter;

    // Wrap sendTransaction
    if (adapter.sendTransaction) {
      this.originalAdapterSendTransaction = adapter.sendTransaction.bind(adapter);
      adapter.sendTransaction = this.wrappedSendTransaction.bind(this);
    }

    // Wrap signMessage
    if (adapter.signMessage) {
      this.originalAdapterSignMessage = adapter.signMessage.bind(adapter);
      adapter.signMessage = this.wrappedSignMessage.bind(this);
    }

    // Wrap signTransaction
    if (adapter.signTransaction) {
      this.originalAdapterSignTransaction = adapter.signTransaction.bind(adapter);
      adapter.signTransaction = this.wrappedSignTransaction.bind(this);
    }
  }


  /**
   * Wrapped sendTransaction method for direct adapter
   */
  private async wrappedSendTransaction(
    transaction: SolanaTransaction,
    connection: SolanaConnection,
    options?: SendTransactionOptions
  ): Promise<TransactionSignature> {
    this.checkAndRebindContextAdapter();

    if (!this.originalAdapterSendTransaction) {
      throw new Error("sendTransaction not available");
    }

    // Capture chainId at call time to ensure consistency across all events
    const chainId = this.chainId;
    const address = this.getCurrentAddress();

    this.emitTransactionEvent(TransactionStatus.STARTED, address, chainId);

    try {
      const signature = await this.originalAdapterSendTransaction(
        transaction,
        connection,
        options
      );

      this.emitTransactionEvent(TransactionStatus.BROADCASTED, address, chainId, signature);

      if (address && this.formo.isAutocaptureEnabled("transaction")) {
        this.pendingTransactions.set(signature, {
          address,
          startTime: Date.now(),
        });
        this.pollTransactionConfirmation(signature, address, chainId, connection);
      }

      return signature;
    } catch (error) {
      this.emitTransactionEvent(TransactionStatus.REJECTED, address, chainId);
      throw error;
    }
  }

  /**
   * Wrapped signMessage method for direct adapter
   */
  private async wrappedSignMessage(message: Uint8Array): Promise<Uint8Array> {
    this.checkAndRebindContextAdapter();

    if (!this.originalAdapterSignMessage) {
      throw new Error("signMessage not available");
    }

    const chainId = this.chainId;
    const address = this.getCurrentAddress();
    const messageString = safeDecodeMessage(message);

    this.emitSignatureEvent(SignatureStatus.REQUESTED, address, chainId, messageString);

    try {
      const signature = await this.originalAdapterSignMessage(message);
      const signatureHex = uint8ArrayToHex(signature);
      this.emitSignatureEvent(SignatureStatus.CONFIRMED, address, chainId, messageString, signatureHex);
      return signature;
    } catch (error) {
      this.emitSignatureEvent(SignatureStatus.REJECTED, address, chainId, messageString);
      throw error;
    }
  }

  /**
   * Wrapped signTransaction method for direct adapter
   */
  private async wrappedSignTransaction(
    transaction: SolanaTransaction
  ): Promise<SolanaTransaction> {
    this.checkAndRebindContextAdapter();

    if (!this.originalAdapterSignTransaction) {
      throw new Error("signTransaction not available");
    }

    const chainId = this.chainId;
    const address = this.getCurrentAddress();
    const message = "[Transaction Signature]";

    this.emitSignatureEvent(SignatureStatus.REQUESTED, address, chainId, message);

    try {
      const signedTx = await this.originalAdapterSignTransaction(transaction);
      this.emitSignatureEvent(SignatureStatus.CONFIRMED, address, chainId, message);
      return signedTx;
    } catch (error) {
      this.emitSignatureEvent(SignatureStatus.REJECTED, address, chainId, message);
      throw error;
    }
  }

  /**
   * Check initial connection state
   */
  private async checkInitialConnection(): Promise<void> {
    const publicKey = this.getPublicKey();
    if (publicKey) {
      const address = publicKeyToAddress(publicKey);
      if (address && !isBlockedSolanaAddress(address)) {
        // Skip if we already tracked this address to avoid duplicate connect events
        // (e.g., when setWallet is called repeatedly with the same connected wallet)
        if (
          this.trackingState.lastAddress === address &&
          this.trackingState.lastChainId === this.chainId
        ) {
          logger.debug(
            "SolanaWalletAdapterHandler: Already tracking this address, skipping duplicate connect",
            { address, chainId: this.chainId }
          );
          return;
        }

        this.trackingState.lastAddress = address;
        this.trackingState.lastChainId = this.chainId;

        logger.info(
          "SolanaWalletAdapterHandler: Already connected on initialization",
          {
            address,
            chainId: this.chainId,
          }
        );

        // Emit connect event for already-connected wallets (common in auto-connect scenarios)
        // The wallet adapter's "connect" event only fires during adapter.connect(),
        // not retroactively for already-connected wallets
        if (this.formo.isAutocaptureEnabled("connect")) {
          await this.formo.trackConnectEventOnly(
            {
              chainId: this.chainId,
              address,
            },
            {
              providerName: this.getWalletName(),
              rdns: this.getWalletRdns(),
            }
          );
        }
      }
    }
  }

  /**
   * Handle wallet connect event
   */
  private async handleConnect(publicKey: SolanaPublicKey): Promise<void> {
    if (this.trackingState.isProcessing) {
      logger.debug(
        "SolanaWalletAdapterHandler: Already processing, skipping connect"
      );
      return;
    }

    this.trackingState.isProcessing = true;

    try {
      const address = publicKeyToAddress(publicKey);
      if (!address) {
        logger.warn(
          "SolanaWalletAdapterHandler: Invalid public key on connect"
        );
        return;
      }

      if (isBlockedSolanaAddress(address)) {
        logger.debug(
          "SolanaWalletAdapterHandler: Blocked address, skipping connect event"
        );
        return;
      }

      logger.info("SolanaWalletAdapterHandler: Wallet connected", {
        address,
        chainId: this.chainId,
        walletName: this.getWalletName(),
      });

      this.trackingState.lastAddress = address;
      this.trackingState.lastChainId = this.chainId;

      if (this.formo.isAutocaptureEnabled("connect")) {
        // Use internal method to avoid corrupting shared EVM wallet state
        await this.formo.trackConnectEventOnly(
          {
            chainId: this.chainId,
            address,
          },
          {
            providerName: this.getWalletName(),
            rdns: this.getWalletRdns(),
          }
        );
      }
    } catch (error) {
      logger.error(
        "SolanaWalletAdapterHandler: Error handling connect",
        error
      );
    } finally {
      this.trackingState.isProcessing = false;
    }
  }

  /**
   * Handle wallet disconnect event
   */
  private async handleDisconnect(): Promise<void> {
    if (this.trackingState.isProcessing) {
      logger.debug(
        "SolanaWalletAdapterHandler: Already processing, skipping disconnect"
      );
      return;
    }

    // Only emit disconnect if we have a prior tracked connection
    // This prevents emitting events with undefined address/chainId
    if (!this.trackingState.lastAddress) {
      logger.debug(
        "SolanaWalletAdapterHandler: No prior connection tracked, skipping disconnect event"
      );
      return;
    }

    this.trackingState.isProcessing = true;

    try {
      logger.info("SolanaWalletAdapterHandler: Wallet disconnected", {
        address: this.trackingState.lastAddress,
        chainId: this.trackingState.lastChainId,
      });

      if (this.formo.isAutocaptureEnabled("disconnect")) {
        // Use internal method to avoid corrupting shared EVM wallet state
        await this.formo.trackDisconnectEventOnly({
          chainId: this.trackingState.lastChainId,
          address: this.trackingState.lastAddress,
        });
      }

      this.trackingState.lastAddress = undefined;
      this.trackingState.lastChainId = undefined;
    } catch (error) {
      logger.error(
        "SolanaWalletAdapterHandler: Error handling disconnect",
        error
      );
    } finally {
      this.trackingState.isProcessing = false;
    }
  }

  /**
   * Poll for transaction confirmation
   */
  private async pollTransactionConfirmation(
    signature: string,
    address: string,
    chainId: number,
    connection?: SolanaConnection,
    maxAttempts = 30,
    intervalMs = 2000
  ): Promise<void> {
    // Don't start polling if already cleaned up
    if (this.isCleanedUp) {
      return;
    }

    const conn = connection || this.connection;
    // Prefer getSignatureStatuses (standard web3.js API) over getSignatureStatus (custom wrapper)
    if (!conn || (!conn.getSignatureStatuses && !conn.getSignatureStatus)) {
      logger.debug(
        "SolanaWalletAdapterHandler: No connection for confirmation polling"
      );
      // Clean up pendingTransactions entry since we can't poll for confirmation
      this.pendingTransactions.delete(signature);
      return;
    }

    let attempts = 0;
    let currentTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      // Remove the current timeout ID from tracking since it has fired
      if (currentTimeoutId) {
        this.pollingTimeouts.delete(currentTimeoutId);
        currentTimeoutId = null;
      }

      // Stop polling if cleaned up
      if (this.isCleanedUp) {
        this.pendingTransactions.delete(signature);
        return;
      }

      try {
        // Use standard getSignatureStatuses API if available, fall back to getSignatureStatus
        let status: import("./types").SignatureStatus | null = null;
        if (conn.getSignatureStatuses) {
          const result = await conn.getSignatureStatuses([signature]);
          status = result.value[0];
        } else if (conn.getSignatureStatus) {
          const result = await conn.getSignatureStatus(signature);
          status = result.value;
        }

        if (status) {
          const signatureKey = `${signature}:${status.confirmationStatus}`;

          // Only deduplicate terminal states (confirmed/finalized/err) to prevent
          // duplicate event emissions. Do NOT deduplicate intermediate states like
          // "processed" since we need to keep polling until a terminal state.
          const isTerminalState =
            !!status.err ||
            status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized";

          // Check for duplicate processing of terminal states only
          if (isTerminalState && this.processedSignatures.has(signatureKey)) {
            return;
          }
          if (isTerminalState) {
            this.processedSignatures.add(signatureKey);
          }

          if (status.err) {
            // Transaction failed
            logger.info(
              "SolanaWalletAdapterHandler: Transaction reverted",
              {
                signature,
                error: status.err,
              }
            );

            this.formo.transaction({
              status: TransactionStatus.REVERTED,
              chainId,
              address,
              transactionHash: signature,
            });

            this.pendingTransactions.delete(signature);
            return;
          }

          if (
            status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized"
          ) {
            // Transaction confirmed
            logger.info(
              "SolanaWalletAdapterHandler: Transaction confirmed",
              {
                signature,
                confirmationStatus: status.confirmationStatus,
              }
            );

            this.formo.transaction({
              status: TransactionStatus.CONFIRMED,
              chainId,
              address,
              transactionHash: signature,
            });

            this.pendingTransactions.delete(signature);
            return;
          }
        }
      } catch (error) {
        logger.error(
          "SolanaWalletAdapterHandler: Error polling transaction status",
          error
        );
      }

      attempts++;
      if (attempts < maxAttempts && !this.isCleanedUp) {
        currentTimeoutId = setTimeout(poll, intervalMs);
        this.pollingTimeouts.add(currentTimeoutId);
      } else {
        // Cleanup after max attempts
        this.pendingTransactions.delete(signature);
      }
    };

    // Start polling
    currentTimeoutId = setTimeout(poll, intervalMs);
    this.pollingTimeouts.add(currentTimeoutId);

    // Clean up old processed signatures
    cleanupOldEntries(this.processedSignatures);
  }

  /**
   * Get current wallet public key
   */
  private getPublicKey(): SolanaPublicKey | null {
    return this.wallet?.publicKey ?? null;
  }

  /**
   * Get current address
   */
  private getCurrentAddress(): string | null {
    // First check tracking state
    if (this.trackingState.lastAddress) {
      return this.trackingState.lastAddress;
    }

    // Then check wallet, filtering out blocked addresses (system programs, etc.)
    const publicKey = this.getPublicKey();
    const address = publicKey ? publicKeyToAddress(publicKey) : null;
    if (address && isBlockedSolanaAddress(address)) {
      return null;
    }
    return address;
  }

  // ============================================================
  // Event Emission Helpers
  // ============================================================

  /**
   * Emit a transaction event if address is valid and autocapture is enabled
   */
  private emitTransactionEvent(
    status: TransactionStatus,
    address: string | null,
    chainId: number,
    transactionHash?: string
  ): void {
    if (address && this.formo.isAutocaptureEnabled("transaction")) {
      this.formo.transaction({
        status,
        chainId,
        address,
        ...(transactionHash && { transactionHash }),
      });
    }
  }

  /**
   * Emit a signature event if address is valid and autocapture is enabled
   */
  private emitSignatureEvent(
    status: SignatureStatus,
    address: string | null,
    chainId: number,
    message: string,
    signatureHash?: string
  ): void {
    if (address && this.formo.isAutocaptureEnabled("signature")) {
      this.formo.signature({
        status,
        chainId,
        address,
        message,
        ...(signatureHash && { signatureHash }),
      });
    }
  }

  /**
   * Extract the actual adapter (with .on/.off) from a wallet context.
   * In @solana/wallet-adapter-react, context.wallet is { adapter, readyState },
   * not a direct adapter.
   */
  private getAdapterFromContext(context: SolanaWalletContext): SolanaWalletAdapter | null {
    const wallet = context.wallet;
    if (!wallet) return null;

    // wallet-adapter-react: wallet is { adapter, readyState }
    if (wallet.adapter && typeof wallet.adapter.on === "function") {
      return wallet.adapter;
    }

    return null;
  }

  /**
   * Get wallet name
   */
  private getWalletName(): string {
    if (!this.wallet) {
      return "Unknown Solana Wallet";
    }

    if (isSolanaWalletContext(this.wallet)) {
      const adapter = this.getAdapterFromContext(this.wallet);
      return adapter?.name || "Unknown Solana Wallet";
    }

    return this.wallet.name;
  }

  /**
   * Get wallet RDNS (reverse domain name)
   * For Solana wallets, we construct an RDNS-like identifier
   */
  private getWalletRdns(): string {
    const name = this.getWalletName().toLowerCase().replace(/\s+/g, "");
    return `sol.wallet.${name}`;
  }

  /**
   * Clean up wallet listeners
   */
  private cleanupWalletListeners(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.error(
          "SolanaWalletAdapterHandler: Error during listener cleanup",
          error
        );
      }
    }
    this.unsubscribers = [];
    this.currentBoundAdapter = undefined;
  }

  /**
   * Clean up all resources
   */
  public cleanup(): void {
    logger.info("SolanaWalletAdapterHandler: Cleaning up");

    // Set cleanup flag to stop any ongoing polls
    this.isCleanedUp = true;

    // Cancel all active polling timeouts
    Array.from(this.pollingTimeouts).forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this.pollingTimeouts.clear();

    this.cleanupWalletListeners();
    this.processedSignatures.clear();
    this.pendingTransactions.clear();

    // Restore original methods on wrapped adapter
    this.restoreOriginalMethods();

    this.wallet = null;
    this.connection = null;

    logger.info("SolanaWalletAdapterHandler: Cleanup complete");
  }
}
