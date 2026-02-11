/**
 * Session management for Formo Analytics
 * 
 * Handles tracking of detected wallets and identified wallet-address pairs
 * using cookies to maintain state across page loads within a session.
 */

import { cookie } from "../storage";
import { logger } from "../logger";

/**
 * Cookie keys for session tracking
 * NOTE: These values must match the original constants in constants/base.ts
 * to maintain backward compatibility with existing user sessions
 */
export const SESSION_WALLET_DETECTED_KEY = "wallet-detected";
export const SESSION_WALLET_IDENTIFIED_KEY = "wallet-identified";
export const SESSION_USER_IDENTIFIED_KEY = "user-identified";
export const SESSION_WALLET_USER_IDENTIFIED_KEY = "wallet-user-identified";

/**
 * Interface for session management operations
 */
export interface IFormoAnalyticsSession {
  /**
   * Check if a wallet has been detected in this session
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  isWalletDetected(rdns: string): boolean;
  
  /**
   * Mark a wallet as detected in this session
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  markWalletDetected(rdns: string): void;
  
  /**
   * Check if a wallet-address pair has been identified in this session
   * @param address The wallet address
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  isWalletIdentified(address: string, rdns: string): boolean;
  
  /**
   * Mark a wallet-address pair as identified in this session
   * @param address The wallet address
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  markWalletIdentified(address: string, rdns: string): void;

  /**
   * Check if a user has been identified in this session
   * @param userId The external user ID
   */
  isUserIdentified(userId: string): boolean;

  /**
   * Mark a user as identified in this session
   * @param userId The external user ID
   */
  markUserIdentified(userId: string): void;

  /**
   * Check if a wallet-user pair has been identified in this session
   * @param address The wallet address
   * @param userId The external user ID
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  isWalletUserIdentified(address: string, userId: string, rdns: string): boolean;

  /**
   * Mark a wallet-user pair as identified in this session
   * @param address The wallet address
   * @param userId The external user ID
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  markWalletUserIdentified(address: string, userId: string, rdns: string): void;
}

/**
 * Implementation of session management using cookies
 * 
 * Tracks:
 * - Detected wallets (by RDNS) - to prevent duplicate detection events
 * - Identified wallet-address pairs - to prevent duplicate identification events
 * 
 * Session data expires at end of day (86400 seconds).
 */
export class FormoAnalyticsSession implements IFormoAnalyticsSession {
  /**
   * Generate a unique key for wallet identification tracking
   * Combines address and RDNS to track specific wallet-address combinations
   * 
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   * @returns A unique identification key
   */
  private generateIdentificationKey(address: string, rdns: string): string {
    // If rdns is missing, use address-only key as fallback for empty identifies
    return rdns ? `${address}:${rdns}` : address;
  }

  /**
   * Generate a unique key for wallet-user identification tracking
   * 
   * @param address The wallet address
   * @param userId The external user ID
   * @param rdns The reverse domain name of the wallet provider
   * @returns A unique identification key for wallet-user pairs
   */
  private generateWalletUserIdentificationKey(
    address: string,
    userId: string,
    rdns: string
  ): string {
    const walletKey = this.generateIdentificationKey(address, rdns);
    return `${walletKey}:${userId}`;
  }

  private encodeCookieValue(value: string): string {
    return encodeURIComponent(value);
  }

  private decodeCookieValue(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  /**
   * Check if a wallet provider has been detected in this session
   * 
   * @param rdns The reverse domain name of the wallet provider
   * @returns true if the wallet has been detected
   */
  public isWalletDetected(rdns: string): boolean {
    const rdnses = cookie().get(SESSION_WALLET_DETECTED_KEY)?.split(",") || [];
    return rdnses.includes(rdns);
  }

  /**
   * Mark a wallet provider as detected in this session
   * Prevents duplicate detection events from being emitted
   * 
   * @param rdns The reverse domain name of the wallet provider
   */
  public markWalletDetected(rdns: string): void {
    const rdnses = cookie().get(SESSION_WALLET_DETECTED_KEY)?.split(",") || [];
    if (!rdnses.includes(rdns)) {
      rdnses.push(rdns);
      cookie().set(SESSION_WALLET_DETECTED_KEY, rdnses.join(","), {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
      });
    }
  }

  /**
   * Check if a specific wallet-address combination has been identified
   * 
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   * @returns true if this wallet-address pair has been identified
   */
  public isWalletIdentified(address: string, rdns: string): boolean {
    const identifiedKey = this.generateIdentificationKey(address, rdns);
    const cookieValue = cookie().get(SESSION_WALLET_IDENTIFIED_KEY);
    const identifiedWallets = cookieValue?.split(",") || [];
    const isIdentified = identifiedWallets.includes(identifiedKey);
    
    logger.debug("Session: Checking wallet identification", {
      identifiedKey,
      isIdentified,
      hasRdns: !!rdns,
    });
    
    return isIdentified;
  }

  /**
   * Mark a wallet-address combination as identified in this session
   * Prevents duplicate identification events from being emitted
   * 
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   */
  public markWalletIdentified(address: string, rdns: string): void {
    const identifiedKey = this.generateIdentificationKey(address, rdns);
    const identifiedWallets =
      cookie().get(SESSION_WALLET_IDENTIFIED_KEY)?.split(",") || [];
    
    if (!identifiedWallets.includes(identifiedKey)) {
      identifiedWallets.push(identifiedKey);
      const newValue = identifiedWallets.join(",");
      cookie().set(SESSION_WALLET_IDENTIFIED_KEY, newValue, {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
      });
      
      logger.debug("Session: Marked wallet as identified", {
        identifiedKey,
        hasRdns: !!rdns,
      });
    } else {
      logger.info("Session: Wallet already marked as identified", {
        identifiedKey,
        existingWallets: identifiedWallets,
        hasRdns: !!rdns,
      });
    }
  }

  /**
   * Check if a user has been identified in this session
   * 
   * @param userId The external user ID
   * @returns true if this user has been identified
   */
  public isUserIdentified(userId: string): boolean {
    const cookieValue = cookie().get(SESSION_USER_IDENTIFIED_KEY);
    const identifiedUsers = (cookieValue?.split(",") || []).map((value) =>
      this.decodeCookieValue(value)
    );
    const isIdentified = identifiedUsers.includes(userId);

    logger.debug("Session: Checking user identification", {
      userId,
      isIdentified,
    });

    return isIdentified;
  }

  /**
   * Mark a user as identified in this session
   * Prevents duplicate identification events from being emitted
   * 
   * @param userId The external user ID
   */
  public markUserIdentified(userId: string): void {
    const identifiedUsers =
      cookie().get(SESSION_USER_IDENTIFIED_KEY)?.split(",") || [];
    const alreadyExists = identifiedUsers
      .map((value) => this.decodeCookieValue(value))
      .includes(userId);

    if (!alreadyExists) {
      identifiedUsers.push(this.encodeCookieValue(userId));
      const newValue = identifiedUsers.join(",");
      cookie().set(SESSION_USER_IDENTIFIED_KEY, newValue, {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
      });

      logger.debug("Session: Marked user as identified", {
        userId,
      });
    } else {
      logger.info("Session: User already marked as identified", {
        userId,
        existingUsers: identifiedUsers,
      });
    }
  }

  /**
   * Check if a wallet-user pair has been identified
   * 
   * @param address The wallet address
   * @param userId The external user ID
   * @param rdns The reverse domain name of the wallet provider
   * @returns true if this wallet-user pair has been identified
   */
  public isWalletUserIdentified(
    address: string,
    userId: string,
    rdns: string
  ): boolean {
    const identifiedKey = this.generateWalletUserIdentificationKey(
      address,
      userId,
      rdns
    );
    const cookieValue = cookie().get(SESSION_WALLET_USER_IDENTIFIED_KEY);
    const identifiedPairs = (cookieValue?.split(",") || []).map((value) =>
      this.decodeCookieValue(value)
    );
    const isIdentified = identifiedPairs.includes(identifiedKey);

    logger.debug("Session: Checking wallet-user identification", {
      identifiedKey,
      isIdentified,
      hasRdns: !!rdns,
    });

    return isIdentified;
  }

  /**
   * Mark a wallet-user pair as identified in this session
   * Prevents duplicate identification events from being emitted
   * 
   * @param address The wallet address
   * @param userId The external user ID
   * @param rdns The reverse domain name of the wallet provider
   */
  public markWalletUserIdentified(
    address: string,
    userId: string,
    rdns: string
  ): void {
    const identifiedKey = this.generateWalletUserIdentificationKey(
      address,
      userId,
      rdns
    );
    const identifiedPairs =
      cookie().get(SESSION_WALLET_USER_IDENTIFIED_KEY)?.split(",") || [];
    const alreadyExists = identifiedPairs
      .map((value) => this.decodeCookieValue(value))
      .includes(identifiedKey);

    if (!alreadyExists) {
      identifiedPairs.push(this.encodeCookieValue(identifiedKey));
      const newValue = identifiedPairs.join(",");
      cookie().set(SESSION_WALLET_USER_IDENTIFIED_KEY, newValue, {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
      });

      logger.debug("Session: Marked wallet-user pair as identified", {
        identifiedKey,
        hasRdns: !!rdns,
      });
    } else {
      logger.info("Session: Wallet-user pair already marked as identified", {
        identifiedKey,
        existingPairs: identifiedPairs,
        hasRdns: !!rdns,
      });
    }
  }
}

