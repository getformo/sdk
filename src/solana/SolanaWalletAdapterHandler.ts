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
  WalletError,
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
   * Original context methods that we wrap for tracking
   */
  private originalContextSendTransaction?: SolanaWalletContext["sendTransaction"];
  private originalContextSignMessage?: SolanaWalletContext["signMessage"];
  private originalContextSignTransaction?: SolanaWalletContext["signTransaction"];

  /**
   * Reference to the wrapped context (to restore methods on cleanup)
   */
  private wrappedContext?: SolanaWalletContext;

  /**
   * Reference to the wrapped adapter (to restore methods on cleanup)
   */
  private wrappedAdapter?: SolanaWalletAdapter;

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
      chainId?: number;
    }
  ) {
    this.formo = formoAnalytics;
    this.wallet = options.wallet || null;
    this.connection = options.connection || null;
    this.cluster = options.cluster || "mainnet-beta";
    this.chainId = options.chainId || SOLANA_CHAIN_IDS[this.cluster];

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
   * Restore original methods on the wrapped wallet/context
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

    // Restore context methods
    if (this.wrappedContext) {
      if (this.originalContextSendTransaction) {
        this.wrappedContext.sendTransaction = this.originalContextSendTransaction;
      }
      if (this.originalContextSignMessage) {
        this.wrappedContext.signMessage = this.originalContextSignMessage;
      }
      if (this.originalContextSignTransaction) {
        this.wrappedContext.signTransaction = this.originalContextSignTransaction;
      }
      this.wrappedContext = undefined;
    }

    // Clear original method references
    this.originalAdapterSendTransaction = undefined;
    this.originalAdapterSignMessage = undefined;
    this.originalAdapterSignTransaction = undefined;
    this.originalContextSendTransaction = undefined;
    this.originalContextSignMessage = undefined;
    this.originalContextSignTransaction = undefined;
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
      this.setupWalletListeners();
    }
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

    // Emit chain change event if connected and cluster changed
    if (
      previousCluster !== cluster &&
      this.trackingState.lastAddress &&
      this.formo.isAutocaptureEnabled("chain")
    ) {
      this.formo.chain({
        chainId: this.chainId,
        address: this.trackingState.lastAddress,
      });
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
    this.checkInitialConnection();

    logger.info(
      "SolanaWalletAdapterHandler: Wallet listeners set up successfully"
    );
  }

  /**
   * Set up listeners for a wallet context (useWallet)
   */
  private setupContextListeners(context: SolanaWalletContext): void {
    // For context-based wallets, we set up event listeners on the inner adapter
    // but only wrap the context methods (not adapter methods) to avoid double tracking.
    // The context methods are the user-facing API that we want to track.

    if (context.wallet) {
      // Only add event listeners (connect/disconnect) on the inner adapter
      // Do NOT wrap adapter methods - we'll wrap context methods instead
      this.setupAdapterEventListenersOnly(context.wallet);
    }

    // Wrap context methods for transaction/signature tracking
    this.wrapContextMethods(context);
  }

  /**
   * Set up only event listeners on an adapter (no method wrapping)
   * Used when wrapping context methods to avoid double tracking
   */
  private setupAdapterEventListenersOnly(adapter: SolanaWalletAdapter): void {
    // Connect event
    const connectListener = (publicKey: SolanaPublicKey) => {
      this.handleConnect(publicKey);
    };
    adapter.on("connect", connectListener);
    this.unsubscribers.push(() =>
      adapter.off("connect", connectListener as (...args: unknown[]) => void)
    );

    // Disconnect event
    const disconnectListener = () => {
      this.handleDisconnect();
    };
    adapter.on("disconnect", disconnectListener);
    this.unsubscribers.push(() =>
      adapter.off("disconnect", disconnectListener as (...args: unknown[]) => void)
    );

    // Error event
    const errorListener = (error: unknown) => {
      logger.error("SolanaWalletAdapterHandler: Wallet error", error);
    };
    adapter.on("error", errorListener as (error: WalletError) => void);
    this.unsubscribers.push(() =>
      adapter.off("error", errorListener as (...args: unknown[]) => void)
    );
  }

  /**
   * Set up listeners for a direct wallet adapter
   */
  private setupAdapterListeners(adapter: SolanaWalletAdapter): void {
    // Connect event
    const connectListener = (publicKey: SolanaPublicKey) => {
      this.handleConnect(publicKey);
    };
    adapter.on("connect", connectListener);
    this.unsubscribers.push(() =>
      adapter.off("connect", connectListener as (...args: unknown[]) => void)
    );

    // Disconnect event
    const disconnectListener = () => {
      this.handleDisconnect();
    };
    adapter.on("disconnect", disconnectListener);
    this.unsubscribers.push(() =>
      adapter.off("disconnect", disconnectListener as (...args: unknown[]) => void)
    );

    // Error event
    const errorListener = (error: unknown) => {
      logger.error("SolanaWalletAdapterHandler: Wallet error", error);
    };
    adapter.on("error", errorListener as (error: WalletError) => void);
    this.unsubscribers.push(() =>
      adapter.off("error", errorListener as (...args: unknown[]) => void)
    );

    // Wrap adapter methods for tracking
    this.wrapAdapterMethods(adapter);
  }

  /**
   * Wrap wallet adapter methods for transaction/signature tracking
   */
  private wrapAdapterMethods(adapter: SolanaWalletAdapter): void {
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
   * Wrap wallet context methods for transaction/signature tracking
   */
  private wrapContextMethods(context: SolanaWalletContext): void {
    // Store reference to context for cleanup
    this.wrappedContext = context;

    // Store original methods in class properties for cleanup
    this.originalContextSendTransaction = context.sendTransaction.bind(context);
    this.originalContextSignMessage = context.signMessage?.bind(context);
    this.originalContextSignTransaction = context.signTransaction?.bind(context);

    // Also store in local variables for use in closures below
    const originalSendTransaction = this.originalContextSendTransaction;
    const originalSignMessage = this.originalContextSignMessage;
    const originalSignTransaction = this.originalContextSignTransaction;

    // Wrap sendTransaction
    context.sendTransaction = async (
      transaction: SolanaTransaction,
      connection: SolanaConnection,
      options?: SendTransactionOptions
    ): Promise<TransactionSignature> => {
      const address = this.getCurrentAddress();

      if (address && this.formo.isAutocaptureEnabled("transaction")) {
        // Track transaction started
        this.formo.transaction({
          status: TransactionStatus.STARTED,
          chainId: this.chainId,
          address,
        });
      }

      try {
        const signature = await originalSendTransaction(
          transaction,
          connection,
          options
        );

        if (address && this.formo.isAutocaptureEnabled("transaction")) {
          // Track transaction broadcasted
          this.formo.transaction({
            status: TransactionStatus.BROADCASTED,
            chainId: this.chainId,
            address,
            transactionHash: signature,
          });

          // Store for confirmation tracking
          this.pendingTransactions.set(signature, {
            address,
            startTime: Date.now(),
          });

          // Start polling for confirmation
          this.pollTransactionConfirmation(signature, address, connection);
        }

        return signature;
      } catch (error) {
        if (address && this.formo.isAutocaptureEnabled("transaction")) {
          // Track transaction rejected
          this.formo.transaction({
            status: TransactionStatus.REJECTED,
            chainId: this.chainId,
            address,
          });
        }
        throw error;
      }
    };

    // Wrap signMessage
    if (originalSignMessage) {
      context.signMessage = async (
        message: Uint8Array
      ): Promise<Uint8Array> => {
        const address = this.getCurrentAddress();
        const messageString = new TextDecoder().decode(message);

        if (address && this.formo.isAutocaptureEnabled("signature")) {
          // Track signature requested
          this.formo.signature({
            status: SignatureStatus.REQUESTED,
            chainId: this.chainId,
            address,
            message: messageString,
          });
        }

        try {
          const signature = await originalSignMessage(message);

          if (address && this.formo.isAutocaptureEnabled("signature")) {
            // Track signature confirmed
            const signatureHex = uint8ArrayToHex(signature);
            this.formo.signature({
              status: SignatureStatus.CONFIRMED,
              chainId: this.chainId,
              address,
              message: messageString,
              signatureHash: signatureHex,
            });
          }

          return signature;
        } catch (error) {
          if (address && this.formo.isAutocaptureEnabled("signature")) {
            // Track signature rejected
            this.formo.signature({
              status: SignatureStatus.REJECTED,
              chainId: this.chainId,
              address,
              message: messageString,
            });
          }
          throw error;
        }
      };
    }

    // Wrap signTransaction
    if (originalSignTransaction) {
      context.signTransaction = async (
        transaction: SolanaTransaction
      ): Promise<SolanaTransaction> => {
        const address = this.getCurrentAddress();

        if (address && this.formo.isAutocaptureEnabled("signature")) {
          // Track signature requested (signing a transaction is a form of signature)
          this.formo.signature({
            status: SignatureStatus.REQUESTED,
            chainId: this.chainId,
            address,
            message: "[Transaction Signature]",
          });
        }

        try {
          const signedTx = await originalSignTransaction(transaction);

          if (address && this.formo.isAutocaptureEnabled("signature")) {
            // Track signature confirmed
            this.formo.signature({
              status: SignatureStatus.CONFIRMED,
              chainId: this.chainId,
              address,
              message: "[Transaction Signature]",
            });
          }

          return signedTx;
        } catch (error) {
          if (address && this.formo.isAutocaptureEnabled("signature")) {
            // Track signature rejected
            this.formo.signature({
              status: SignatureStatus.REJECTED,
              chainId: this.chainId,
              address,
              message: "[Transaction Signature]",
            });
          }
          throw error;
        }
      };
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
    if (!this.originalAdapterSendTransaction) {
      throw new Error("sendTransaction not available");
    }

    const address = this.getCurrentAddress();

    if (address && this.formo.isAutocaptureEnabled("transaction")) {
      this.formo.transaction({
        status: TransactionStatus.STARTED,
        chainId: this.chainId,
        address,
      });
    }

    try {
      const signature = await this.originalAdapterSendTransaction(
        transaction,
        connection,
        options
      );

      if (address && this.formo.isAutocaptureEnabled("transaction")) {
        this.formo.transaction({
          status: TransactionStatus.BROADCASTED,
          chainId: this.chainId,
          address,
          transactionHash: signature,
        });

        this.pendingTransactions.set(signature, {
          address,
          startTime: Date.now(),
        });

        this.pollTransactionConfirmation(signature, address, connection);
      }

      return signature;
    } catch (error) {
      if (address && this.formo.isAutocaptureEnabled("transaction")) {
        this.formo.transaction({
          status: TransactionStatus.REJECTED,
          chainId: this.chainId,
          address,
        });
      }
      throw error;
    }
  }

  /**
   * Wrapped signMessage method for direct adapter
   */
  private async wrappedSignMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.originalAdapterSignMessage) {
      throw new Error("signMessage not available");
    }

    const address = this.getCurrentAddress();
    const messageString = new TextDecoder().decode(message);

    if (address && this.formo.isAutocaptureEnabled("signature")) {
      this.formo.signature({
        status: SignatureStatus.REQUESTED,
        chainId: this.chainId,
        address,
        message: messageString,
      });
    }

    try {
      const signature = await this.originalAdapterSignMessage(message);

      if (address && this.formo.isAutocaptureEnabled("signature")) {
        const signatureHex = uint8ArrayToHex(signature);
        this.formo.signature({
          status: SignatureStatus.CONFIRMED,
          chainId: this.chainId,
          address,
          message: messageString,
          signatureHash: signatureHex,
        });
      }

      return signature;
    } catch (error) {
      if (address && this.formo.isAutocaptureEnabled("signature")) {
        this.formo.signature({
          status: SignatureStatus.REJECTED,
          chainId: this.chainId,
          address,
          message: messageString,
        });
      }
      throw error;
    }
  }

  /**
   * Wrapped signTransaction method for direct adapter
   */
  private async wrappedSignTransaction(
    transaction: SolanaTransaction
  ): Promise<SolanaTransaction> {
    if (!this.originalAdapterSignTransaction) {
      throw new Error("signTransaction not available");
    }

    const address = this.getCurrentAddress();

    if (address && this.formo.isAutocaptureEnabled("signature")) {
      this.formo.signature({
        status: SignatureStatus.REQUESTED,
        chainId: this.chainId,
        address,
        message: "[Transaction Signature]",
      });
    }

    try {
      const signedTx = await this.originalAdapterSignTransaction(transaction);

      if (address && this.formo.isAutocaptureEnabled("signature")) {
        this.formo.signature({
          status: SignatureStatus.CONFIRMED,
          chainId: this.chainId,
          address,
          message: "[Transaction Signature]",
        });
      }

      return signedTx;
    } catch (error) {
      if (address && this.formo.isAutocaptureEnabled("signature")) {
        this.formo.signature({
          status: SignatureStatus.REJECTED,
          chainId: this.chainId,
          address,
          message: "[Transaction Signature]",
        });
      }
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
    connection?: SolanaConnection,
    maxAttempts = 30,
    intervalMs = 2000
  ): Promise<void> {
    // Don't start polling if already cleaned up
    if (this.isCleanedUp) {
      return;
    }

    const conn = connection || this.connection;
    if (!conn || !conn.getSignatureStatus) {
      logger.debug(
        "SolanaWalletAdapterHandler: No connection for confirmation polling"
      );
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
        const result = await conn.getSignatureStatus!(signature);
        const status = result.value;

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
              chainId: this.chainId,
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
              chainId: this.chainId,
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
    if (!this.wallet) {
      return null;
    }

    if (isSolanaWalletContext(this.wallet)) {
      return this.wallet.publicKey;
    }

    return this.wallet.publicKey;
  }

  /**
   * Get current address
   */
  private getCurrentAddress(): string | null {
    // First check tracking state
    if (this.trackingState.lastAddress) {
      return this.trackingState.lastAddress;
    }

    // Then check wallet
    const publicKey = this.getPublicKey();
    return publicKey ? publicKeyToAddress(publicKey) : null;
  }

  /**
   * Get wallet name
   */
  private getWalletName(): string {
    if (!this.wallet) {
      return "Unknown Solana Wallet";
    }

    if (isSolanaWalletContext(this.wallet)) {
      return this.wallet.wallet?.name || "Unknown Solana Wallet";
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

    // Restore original methods on both adapter and context
    this.restoreOriginalMethods();

    this.wallet = null;
    this.connection = null;

    logger.info("SolanaWalletAdapterHandler: Cleanup complete");
  }
}
