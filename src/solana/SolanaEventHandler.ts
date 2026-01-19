/**
 * SolanaEventHandler
 *
 * Handles wallet event tracking by monitoring the Solana wallet adapter state.
 * This follows the same pattern as WagmiEventHandler for EVM wallets.
 *
 * The handler tracks:
 * - Wallet connection/disconnection events
 * - Wallet detection events
 * - Message signing events (when using wrapped methods)
 * - Transaction events (when using wrapped methods)
 */

import { FormoAnalytics } from "../FormoAnalytics";
import { SignatureStatus, TransactionStatus } from "../types/events";
import { logger } from "../logger";
import {
  SolanaWalletAdapter,
  SolanaCluster,
  SolanaTrackingState,
  SOLANA_CHAIN_IDS,
  KNOWN_SOLANA_WALLETS,
  UnsubscribeFn,
} from "./types";
import {
  isValidSolanaAddress,
  isBlockedSolanaAddress,
} from "../utils/solana-address";

export class SolanaEventHandler {
  private formo: FormoAnalytics;
  private wallet: SolanaWalletAdapter;
  private cluster: SolanaCluster;
  private trackingState: SolanaTrackingState = {
    isProcessing: false,
  };
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupFns: UnsubscribeFn[] = [];

  /** Polling interval for wallet state changes (ms) */
  private static readonly POLL_INTERVAL_MS = 500;

  constructor(
    formoAnalytics: FormoAnalytics,
    wallet: SolanaWalletAdapter,
    cluster: SolanaCluster = "mainnet-beta"
  ) {
    this.formo = formoAnalytics;
    this.wallet = wallet;
    this.cluster = cluster;

    logger.info("SolanaEventHandler: Initializing Solana wallet integration", {
      cluster,
      walletName: wallet.wallet?.adapter?.name,
    });

    // Detect wallet if available
    this.detectWallet();

    // Set up state polling for connection changes
    this.setupStatePolling();

    // Wrap wallet methods for event tracking
    this.wrapWalletMethods();
  }

  /**
   * Get the pseudo chain ID for the current Solana cluster
   */
  private getChainId(): number {
    return SOLANA_CHAIN_IDS[this.cluster] || SOLANA_CHAIN_IDS["mainnet-beta"];
  }

  /**
   * Get the current wallet address as a base58 string
   */
  private getAddress(): string | undefined {
    if (this.wallet.publicKey) {
      return this.wallet.publicKey.toBase58();
    }
    return undefined;
  }

  /**
   * Get wallet provider info for detection/identification
   */
  private getWalletInfo(): { name: string; rdns: string } {
    const walletName = this.wallet.wallet?.adapter?.name || "Unknown Wallet";

    // Try to match against known wallets
    const knownWallet = KNOWN_SOLANA_WALLETS.find(
      (w) => w.name.toLowerCase() === walletName.toLowerCase()
    );

    if (knownWallet) {
      return { name: knownWallet.name, rdns: knownWallet.rdns };
    }

    // Generate RDNS for unknown wallets
    const rdns = `app.${walletName.toLowerCase().replace(/\s+/g, "")}.solana`;
    return { name: walletName, rdns };
  }

  /**
   * Detect and emit wallet detection event
   */
  private async detectWallet(): Promise<void> {
    if (!this.wallet.wallet) {
      return;
    }

    const { name, rdns } = this.getWalletInfo();

    logger.info("SolanaEventHandler: Detecting Solana wallet", { name, rdns });

    try {
      await this.formo.detect({ providerName: name, rdns });
    } catch (error) {
      logger.error("SolanaEventHandler: Error detecting wallet:", error);
    }
  }

  /**
   * Set up polling to detect wallet connection state changes
   * Since Solana wallet adapter doesn't expose event subscriptions,
   * we poll the state to detect changes
   */
  private setupStatePolling(): void {
    // Initialize tracking state
    this.trackingState.lastConnected = this.wallet.connected;
    this.trackingState.lastAddress = this.getAddress();
    this.trackingState.lastCluster = this.cluster;

    // Handle initial connection if already connected
    if (this.wallet.connected && this.trackingState.lastAddress) {
      this.handleConnect(this.trackingState.lastAddress);
    }

    // Start polling for state changes
    this.pollInterval = setInterval(() => {
      this.checkStateChanges();
    }, SolanaEventHandler.POLL_INTERVAL_MS);

    logger.info("SolanaEventHandler: State polling started");
  }

  /**
   * Check for state changes and emit appropriate events
   */
  private async checkStateChanges(): Promise<void> {
    // Skip if already processing
    if (this.trackingState.isProcessing) {
      return;
    }

    // Skip if wallet is in transition state
    if (this.wallet.connecting || this.wallet.disconnecting) {
      return;
    }

    const currentConnected = this.wallet.connected;
    const currentAddress = this.getAddress();
    const wasConnected = this.trackingState.lastConnected;
    const lastAddress = this.trackingState.lastAddress;

    // Detect connection
    if (currentConnected && !wasConnected && currentAddress) {
      await this.handleConnect(currentAddress);
    }

    // Detect disconnection
    if (!currentConnected && wasConnected) {
      await this.handleDisconnect(lastAddress);
    }

    // Detect account change (connected but different address)
    if (
      currentConnected &&
      wasConnected &&
      currentAddress &&
      currentAddress !== lastAddress
    ) {
      // Emit disconnect for old address, then connect for new
      await this.handleDisconnect(lastAddress);
      await this.handleConnect(currentAddress);
    }

    // Update tracking state
    this.trackingState.lastConnected = currentConnected;
    this.trackingState.lastAddress = currentAddress;
  }

  /**
   * Handle wallet connection
   */
  private async handleConnect(address: string): Promise<void> {
    if (this.trackingState.isProcessing) {
      return;
    }

    this.trackingState.isProcessing = true;

    try {
      // Validate address
      if (!isValidSolanaAddress(address)) {
        logger.warn("SolanaEventHandler: Invalid Solana address", { address });
        return;
      }

      if (isBlockedSolanaAddress(address)) {
        logger.debug("SolanaEventHandler: Blocked address, skipping", {
          address,
        });
        return;
      }

      const chainId = this.getChainId();
      const { name: providerName } = this.getWalletInfo();

      logger.info("SolanaEventHandler: Wallet connected", {
        address,
        chainId,
        cluster: this.cluster,
        providerName,
      });

      // Emit connect event
      if (this.formo.isAutocaptureEnabled("connect")) {
        await this.formo.connect(
          { chainId, address },
          { providerName, blockchain: "solana", cluster: this.cluster }
        );
      }

      // Update tracking state
      this.trackingState.lastAddress = address;
      this.trackingState.lastCluster = this.cluster;
    } catch (error) {
      logger.error("SolanaEventHandler: Error handling connect:", error);
    } finally {
      this.trackingState.isProcessing = false;
    }
  }

  /**
   * Handle wallet disconnection
   */
  private async handleDisconnect(lastAddress?: string): Promise<void> {
    if (this.trackingState.isProcessing) {
      return;
    }

    this.trackingState.isProcessing = true;

    try {
      const chainId = this.getChainId();

      logger.info("SolanaEventHandler: Wallet disconnected", {
        address: lastAddress,
        chainId,
        cluster: this.cluster,
      });

      // Emit disconnect event
      if (this.formo.isAutocaptureEnabled("disconnect")) {
        await this.formo.disconnect(
          { chainId, address: lastAddress },
          { blockchain: "solana", cluster: this.cluster }
        );
      }

      // Clear tracking state
      this.trackingState.lastAddress = undefined;
    } catch (error) {
      logger.error("SolanaEventHandler: Error handling disconnect:", error);
    } finally {
      this.trackingState.isProcessing = false;
    }
  }

  /**
   * Wrap wallet methods to intercept signing and transaction events
   */
  private wrapWalletMethods(): void {
    // Wrap signMessage if available
    if (this.wallet.signMessage) {
      const originalSignMessage = this.wallet.signMessage.bind(this.wallet);
      this.wallet.signMessage = async (message: Uint8Array) => {
        return this.wrapSignMessage(originalSignMessage, message);
      };

      this.cleanupFns.push(() => {
        this.wallet.signMessage = originalSignMessage;
      });
    }

    // Wrap sendTransaction if available
    if (this.wallet.sendTransaction) {
      const originalSendTransaction = this.wallet.sendTransaction.bind(
        this.wallet
      );
      this.wallet.sendTransaction = async <T>(
        transaction: T,
        connection: unknown,
        options?: unknown
      ) => {
        return this.wrapSendTransaction(
          originalSendTransaction,
          transaction,
          connection,
          options
        );
      };

      this.cleanupFns.push(() => {
        this.wallet.sendTransaction = originalSendTransaction;
      });
    }

    logger.info("SolanaEventHandler: Wallet methods wrapped for event tracking");
  }

  /**
   * Wrapped signMessage that tracks signature events
   */
  private async wrapSignMessage(
    originalFn: (message: Uint8Array) => Promise<Uint8Array>,
    message: Uint8Array
  ): Promise<Uint8Array> {
    const address = this.getAddress();
    const chainId = this.getChainId();

    if (!address || !this.formo.isAutocaptureEnabled("signature")) {
      return originalFn(message);
    }

    // Convert message to string for logging
    const messageStr = new TextDecoder().decode(message);

    // Emit signature requested event
    try {
      await this.formo.signature({
        status: SignatureStatus.REQUESTED,
        chainId,
        address,
        message: messageStr,
      });
    } catch (error) {
      logger.error(
        "SolanaEventHandler: Error emitting signature requested:",
        error
      );
    }

    try {
      const signature = await originalFn(message);

      // Convert signature to base58 string
      const signatureHash = this.uint8ArrayToBase58(signature);

      // Emit signature confirmed event
      await this.formo.signature({
        status: SignatureStatus.CONFIRMED,
        chainId,
        address,
        message: messageStr,
        signatureHash,
      });

      return signature;
    } catch (error) {
      // Emit signature rejected event
      try {
        await this.formo.signature({
          status: SignatureStatus.REJECTED,
          chainId,
          address,
          message: messageStr,
        });
      } catch (trackError) {
        logger.error(
          "SolanaEventHandler: Error emitting signature rejected:",
          trackError
        );
      }

      throw error;
    }
  }

  /**
   * Wrapped sendTransaction that tracks transaction events
   */
  private async wrapSendTransaction<T>(
    originalFn: (
      transaction: T,
      connection: unknown,
      options?: unknown
    ) => Promise<string>,
    transaction: T,
    connection: unknown,
    options?: unknown
  ): Promise<string> {
    const address = this.getAddress();
    const chainId = this.getChainId();

    if (!address || !this.formo.isAutocaptureEnabled("transaction")) {
      return originalFn(transaction, connection, options);
    }

    // Emit transaction started event
    try {
      await this.formo.transaction({
        status: TransactionStatus.STARTED,
        chainId,
        address,
      });
    } catch (error) {
      logger.error(
        "SolanaEventHandler: Error emitting transaction started:",
        error
      );
    }

    try {
      const signature = await originalFn(transaction, connection, options);

      // Emit transaction broadcasted event
      await this.formo.transaction({
        status: TransactionStatus.BROADCASTED,
        chainId,
        address,
        transactionHash: signature,
      });

      return signature;
    } catch (error) {
      // Emit transaction rejected event
      try {
        await this.formo.transaction({
          status: TransactionStatus.REJECTED,
          chainId,
          address,
        });
      } catch (trackError) {
        logger.error(
          "SolanaEventHandler: Error emitting transaction rejected:",
          trackError
        );
      }

      throw error;
    }
  }

  /**
   * Convert Uint8Array to base58 string
   * Simple implementation for signature display
   */
  private uint8ArrayToBase58(bytes: Uint8Array): string {
    const ALPHABET =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let result = "";

    // Convert bytes to a big integer using index-based loop for ES5 compatibility
    let value = BigInt(0);
    for (let i = 0; i < bytes.length; i++) {
      value = value * BigInt(256) + BigInt(bytes[i]);
    }

    // Convert to base58
    while (value > 0) {
      const remainder = Number(value % BigInt(58));
      value = value / BigInt(58);
      result = ALPHABET[remainder] + result;
    }

    // Add leading '1's for leading zero bytes using index-based loop
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        result = "1" + result;
      } else {
        break;
      }
    }

    return result || "1";
  }

  /**
   * Update the cluster/network
   * Call this if the user switches networks
   */
  public updateCluster(cluster: SolanaCluster): void {
    if (cluster === this.cluster) {
      return;
    }

    const oldCluster = this.cluster;
    this.cluster = cluster;

    logger.info("SolanaEventHandler: Cluster updated", {
      oldCluster,
      newCluster: cluster,
    });

    // If connected, emit a chain change event
    const address = this.getAddress();
    if (this.wallet.connected && address) {
      const chainId = this.getChainId();

      if (this.formo.isAutocaptureEnabled("chain")) {
        this.formo
          .chain(
            { chainId, address },
            { blockchain: "solana", cluster: this.cluster }
          )
          .catch((error) => {
            logger.error(
              "SolanaEventHandler: Error emitting chain change:",
              error
            );
          });
      }
    }

    this.trackingState.lastCluster = cluster;
  }

  /**
   * Manually track a signature event
   * Use this when you need to track signatures outside of the wrapped methods
   */
  public async trackSignature(params: {
    status: SignatureStatus;
    message: string;
    signatureHash?: string;
  }): Promise<void> {
    const address = this.getAddress();
    if (!address) {
      logger.warn(
        "SolanaEventHandler: Cannot track signature, no wallet connected"
      );
      return;
    }

    const chainId = this.getChainId();

    await this.formo.signature({
      status: params.status,
      chainId,
      address,
      message: params.message,
      signatureHash: params.signatureHash,
    });
  }

  /**
   * Manually track a transaction event
   * Use this when you need to track transactions outside of the wrapped methods
   */
  public async trackTransaction(params: {
    status: TransactionStatus;
    transactionHash?: string;
    to?: string;
    value?: string;
  }): Promise<void> {
    const address = this.getAddress();
    if (!address) {
      logger.warn(
        "SolanaEventHandler: Cannot track transaction, no wallet connected"
      );
      return;
    }

    const chainId = this.getChainId();

    await this.formo.transaction({
      status: params.status,
      chainId,
      address,
      transactionHash: params.transactionHash,
      to: params.to,
      value: params.value,
    });
  }

  /**
   * Get the current connected address
   */
  public getConnectedAddress(): string | undefined {
    return this.getAddress();
  }

  /**
   * Get the current cluster
   */
  public getCluster(): SolanaCluster {
    return this.cluster;
  }

  /**
   * Check if wallet is connected
   */
  public isConnected(): boolean {
    return this.wallet.connected;
  }

  /**
   * Clean up all subscriptions and restore original methods
   */
  public cleanup(): void {
    logger.info("SolanaEventHandler: Cleaning up");

    // Stop polling
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Run cleanup functions (restore original methods)
    for (const cleanup of this.cleanupFns) {
      try {
        cleanup();
      } catch (error) {
        logger.error("SolanaEventHandler: Error during cleanup:", error);
      }
    }

    this.cleanupFns = [];
    logger.info("SolanaEventHandler: Cleanup complete");
  }
}
