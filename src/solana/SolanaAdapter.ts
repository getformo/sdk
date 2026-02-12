/**
 * SolanaAdapter
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
  ISolanaAdapter,
  SolanaWalletContext,
  SolanaConnection,
  SolanaCluster,
  SolanaConnectionState,
  SolanaPublicKey,
  TransactionSignature,
  UnsubscribeFn,
  SOLANA_CHAIN_IDS,
  isSolanaWalletContext,
  isSolanaAdapter,
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

export class SolanaAdapter {
  private formo: FormoAnalytics;
  private wallet: ISolanaAdapter | SolanaWalletContext | null = null;
  private connection: SolanaConnection | null = null;
  private cluster: SolanaCluster;
  private chainId: number;
  private unsubscribers: UnsubscribeFn[] = [];
  private connectionState: SolanaConnectionState = {
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
  private originalAdapterSendTransaction?: ISolanaAdapter["sendTransaction"];
  private originalAdapterSignMessage?: ISolanaAdapter["signMessage"];
  private originalAdapterSignTransaction?: ISolanaAdapter["signTransaction"];

  /**
   * Bound wrapper references — used to detect when external code (e.g. StandardWalletAdapter._reset())
   * overwrites our wraps so we can re-apply them.
   */
  private boundWrappedSendTransaction?: ISolanaAdapter["sendTransaction"];
  private boundWrappedSignMessage?: ISolanaAdapter["signMessage"];
  private boundWrappedSignTransaction?: ISolanaAdapter["signTransaction"];

  /**
   * Reference to the wrapped adapter (to restore methods on cleanup)
   */
  private wrappedAdapter?: ISolanaAdapter;

  /**
   * Reference to the adapter we bound event listeners to (for context wallets).
   * Used to detect when context.wallet changes and rebind listeners.
   */
  private currentBoundAdapter?: ISolanaAdapter;

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
      wallet?: ISolanaAdapter | SolanaWalletContext;
      connection?: SolanaConnection;
      cluster?: SolanaCluster;
    }
  ) {
    this.formo = formoAnalytics;
    this.wallet = options.wallet || null;
    this.connection = options.connection || null;
    this.cluster = options.cluster || "mainnet-beta";
    this.chainId = SOLANA_CHAIN_IDS[this.cluster];

    logger.info("SolanaAdapter: Initializing Solana integration", {
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

    // Clear original and bound wrapper references
    this.originalAdapterSendTransaction = undefined;
    this.originalAdapterSignMessage = undefined;
    this.originalAdapterSignTransaction = undefined;
    this.boundWrappedSendTransaction = undefined;
    this.boundWrappedSignMessage = undefined;
    this.boundWrappedSignTransaction = undefined;
  }

  /**
   * Update the wallet instance (useful for React context updates)
   */
  public setWallet(
    wallet: ISolanaAdapter | SolanaWalletContext | null
  ): void {
    // For context-based wallets, if the inner adapter hasn't changed,
    // just update the context reference without tearing down wrapping.
    // This prevents React re-renders from clearing our method wraps.
    if (
      wallet &&
      isSolanaWalletContext(wallet) &&
      this.wallet &&
      isSolanaWalletContext(this.wallet)
    ) {
      const newAdapter = this.getAdapterFromContext(wallet);
      if (newAdapter && newAdapter === this.wrappedAdapter) {
        // Same adapter, just update the context reference
        this.wallet = wallet;
        return;
      }
    }

    // For raw adapters, skip teardown if it's the same object
    if (wallet && wallet === this.wrappedAdapter) {
      return;
    }

    // Restore original methods on previous wallet before cleaning up
    this.restoreOriginalMethods();

    // Clear stale connection state to prevent the old adapter's
    // address/chainId from leaking into disconnect events
    this.connectionState.lastAddress = undefined;
    this.connectionState.lastChainId = undefined;

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
   *   formo.solana.syncWalletState();
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

    // Update connectionState and emit chain event if connected and cluster changed
    if (previousCluster !== cluster && this.connectionState.lastAddress) {
      // Always update connectionState to keep lastChainId in sync for future disconnect events
      this.connectionState.lastChainId = this.chainId;

      if (this.formo.isAutocaptureEnabled("chain")) {
        this.formo.chain({
          chainId: this.chainId,
          address: this.connectionState.lastAddress,
        }).catch((error) => {
          logger.error("SolanaAdapter: Error emitting chain event", error);
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

    logger.info("SolanaAdapter: Setting up wallet listeners");

    // Handle both WalletContext (from useWallet) and direct WalletAdapter
    if (isSolanaWalletContext(this.wallet)) {
      this.setupContextListeners(this.wallet);
    } else if (isSolanaAdapter(this.wallet)) {
      this.setupAdapterListeners(this.wallet);
    }

    // Check if already connected
    this.checkInitialConnection().catch((error) => {
      logger.error(
        "SolanaAdapter: Error checking initial connection",
        error
      );
    });

    logger.info(
      "SolanaAdapter: Wallet listeners set up successfully"
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
        "SolanaAdapter: Detected wallet adapter change, rebinding"
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
            "SolanaAdapter: Error checking initial connection after adapter change",
            error
          );
        });
      } else {
        // No adapter means disconnected
        this.currentBoundAdapter = undefined;
        if (this.connectionState.lastAddress) {
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
          "SolanaAdapter: Error cleaning up adapter listener",
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
    adapter: ISolanaAdapter,
    event: string,
    handler: (...args: unknown[]) => void
  ): void {
    // Use 'any' cast to handle the overloaded on/off signatures
    (adapter as any).on(event, handler);
    this.unsubscribers.push(() => (adapter as any).off(event, handler));
  }

  /**
   * Set up event listeners on an adapter (connect/disconnect events)
   */
  private setupAdapterEventListenersOnly(adapter: ISolanaAdapter): void {
    this.currentBoundAdapter = adapter;

    this.registerAdapterListener(adapter, "connect", (publicKey: unknown) =>
      this.handleConnect(publicKey as SolanaPublicKey)
    );
    this.registerAdapterListener(adapter, "disconnect", () =>
      this.handleDisconnect()
    );
    this.registerAdapterListener(adapter, "error", (error: unknown) =>
      logger.error("SolanaAdapter: Wallet error", error)
    );
  }

  /**
   * Set up listeners for a direct wallet adapter
   */
  private setupAdapterListeners(adapter: ISolanaAdapter): void {
    this.setupAdapterEventListenersOnly(adapter);
    this.wrapAdapterMethods(adapter);
  }

  /**
   * Wrap wallet adapter methods for transaction/signature tracking
   */
  private wrapAdapterMethods(adapter: ISolanaAdapter): void {
    // If we already wrapped this adapter, check if our wraps are still in place.
    // StandardWalletAdapter._reset() overwrites signMessage/signTransaction
    // on every connect/disconnect/feature-change, so we need to re-wrap those methods.
    if (this.wrappedAdapter === adapter) {
      this.rewrapOverwrittenMethods(adapter);
      return;
    }

    // Store reference to adapter for cleanup
    this.wrappedAdapter = adapter;

    // Wrap sendTransaction
    if (adapter.sendTransaction) {
      this.originalAdapterSendTransaction = adapter.sendTransaction.bind(adapter);
      this.boundWrappedSendTransaction = this.wrappedSendTransaction.bind(this);
      adapter.sendTransaction = this.boundWrappedSendTransaction;
    }

    // Wrap signMessage
    if (adapter.signMessage) {
      this.originalAdapterSignMessage = adapter.signMessage.bind(adapter);
      this.boundWrappedSignMessage = this.wrappedSignMessage.bind(this);
      adapter.signMessage = this.boundWrappedSignMessage;
    }

    // Wrap signTransaction
    if (adapter.signTransaction) {
      this.originalAdapterSignTransaction = adapter.signTransaction.bind(adapter);
      this.boundWrappedSignTransaction = this.wrappedSignTransaction.bind(this);
      adapter.signTransaction = this.boundWrappedSignTransaction;
    }

  }

  /**
   * Re-wrap methods that were overwritten by external code.
   *
   * StandardWalletAdapter._reset() overwrites signMessage and signTransaction
   * as own properties on every connect/disconnect/
   * feature-change event. This method detects which wraps were overwritten
   * and re-applies them, capturing the new original methods.
   */
  private rewrapOverwrittenMethods(adapter: ISolanaAdapter): void {
    let rewrapped = false;

    // signMessage
    if (adapter.signMessage && adapter.signMessage !== this.boundWrappedSignMessage) {
      this.originalAdapterSignMessage = adapter.signMessage.bind(adapter);
      if (!this.boundWrappedSignMessage) {
        this.boundWrappedSignMessage = this.wrappedSignMessage.bind(this);
      }
      adapter.signMessage = this.boundWrappedSignMessage;
      rewrapped = true;
    } else if (!adapter.signMessage && this.boundWrappedSignMessage) {
      this.originalAdapterSignMessage = undefined;
    }

    // signTransaction
    if (adapter.signTransaction && adapter.signTransaction !== this.boundWrappedSignTransaction) {
      this.originalAdapterSignTransaction = adapter.signTransaction.bind(adapter);
      if (!this.boundWrappedSignTransaction) {
        this.boundWrappedSignTransaction = this.wrappedSignTransaction.bind(this);
      }
      adapter.signTransaction = this.boundWrappedSignTransaction;
      rewrapped = true;
    } else if (!adapter.signTransaction && this.boundWrappedSignTransaction) {
      this.originalAdapterSignTransaction = undefined;
    }

    // sendTransaction — unlikely to be overwritten but check for completeness
    if (adapter.sendTransaction && adapter.sendTransaction !== this.boundWrappedSendTransaction) {
      this.originalAdapterSendTransaction = adapter.sendTransaction.bind(adapter);
      if (!this.boundWrappedSendTransaction) {
        this.boundWrappedSendTransaction = this.wrappedSendTransaction.bind(this);
      }
      adapter.sendTransaction = this.boundWrappedSendTransaction;
      rewrapped = true;
    }

    if (rewrapped) {
      logger.debug("SolanaAdapter: Re-wrapped overwritten adapter methods");
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
          this.connectionState.lastAddress === address &&
          this.connectionState.lastChainId === this.chainId
        ) {
          logger.debug(
            "SolanaAdapter: Already tracking this address, skipping duplicate connect",
            { address, chainId: this.chainId }
          );
          return;
        }

        this.connectionState.lastAddress = address;
        this.connectionState.lastChainId = this.chainId;

        logger.info(
          "SolanaAdapter: Already connected on initialization",
          {
            address,
            chainId: this.chainId,
          }
        );

        // Emit connect event for already-connected wallets (common in auto-connect scenarios)
        // The wallet adapter's "connect" event only fires during adapter.connect(),
        // not retroactively for already-connected wallets
        if (this.formo.isAutocaptureEnabled("connect")) {
          await this.formo.connect(
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
    if (this.connectionState.isProcessing) {
      logger.debug(
        "SolanaAdapter: Already processing, skipping connect"
      );
      return;
    }

    this.connectionState.isProcessing = true;

    try {
      // Re-wrap methods that may have been overwritten.
      // StandardWalletAdapter._reset() runs before emitting "connect",
      // so signMessage/signTransaction may have been
      // replaced with new own properties by the time we get here.
      if (this.wrappedAdapter) {
        this.rewrapOverwrittenMethods(this.wrappedAdapter);
      }

      const address = publicKeyToAddress(publicKey);
      if (!address) {
        logger.warn(
          "SolanaAdapter: Invalid public key on connect"
        );
        return;
      }

      if (isBlockedSolanaAddress(address)) {
        logger.debug(
          "SolanaAdapter: Blocked address, skipping connect event"
        );
        return;
      }

      logger.info("SolanaAdapter: Wallet connected", {
        address,
        chainId: this.chainId,
        walletName: this.getWalletName(),
      });

      this.connectionState.lastAddress = address;
      this.connectionState.lastChainId = this.chainId;

      if (this.formo.isAutocaptureEnabled("connect")) {
        await this.formo.connect(
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
        "SolanaAdapter: Error handling connect",
        error
      );
    } finally {
      this.connectionState.isProcessing = false;
    }
  }

  /**
   * Handle wallet disconnect event
   */
  private async handleDisconnect(): Promise<void> {
    if (this.connectionState.isProcessing) {
      logger.debug(
        "SolanaAdapter: Already processing, skipping disconnect"
      );
      return;
    }

    // Only emit disconnect if we have a prior tracked connection
    // This prevents emitting events with undefined address/chainId
    if (!this.connectionState.lastAddress) {
      logger.debug(
        "SolanaAdapter: No prior connection tracked, skipping disconnect event"
      );
      return;
    }

    this.connectionState.isProcessing = true;

    try {
      logger.info("SolanaAdapter: Wallet disconnected", {
        address: this.connectionState.lastAddress,
        chainId: this.connectionState.lastChainId,
      });

      if (this.formo.isAutocaptureEnabled("disconnect")) {
        await this.formo.disconnect({
          chainId: this.connectionState.lastChainId,
          address: this.connectionState.lastAddress,
        });
      }

      this.connectionState.lastAddress = undefined;
      this.connectionState.lastChainId = undefined;
    } catch (error) {
      logger.error(
        "SolanaAdapter: Error handling disconnect",
        error
      );
    } finally {
      this.connectionState.isProcessing = false;
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
        "SolanaAdapter: No connection for confirmation polling"
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
              "SolanaAdapter: Transaction reverted",
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
              "SolanaAdapter: Transaction confirmed",
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
          "SolanaAdapter: Error polling transaction status",
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
    if (this.connectionState.lastAddress) {
      return this.connectionState.lastAddress;
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
  private getAdapterFromContext(context: SolanaWalletContext): ISolanaAdapter | null {
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
          "SolanaAdapter: Error during listener cleanup",
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
    logger.debug("SolanaAdapter: Cleaning up");

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

    // Clear connection state to prevent stale data
    this.connectionState.lastAddress = undefined;
    this.connectionState.lastChainId = undefined;

    // Restore original methods on wrapped adapter
    this.restoreOriginalMethods();

    this.wallet = null;
    this.connection = null;

    logger.debug("SolanaAdapter: Cleanup complete");
  }
}
