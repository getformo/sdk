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
    const alreadyExists = identifiedWallets.includes(identifiedKey);

    if (!alreadyExists) {
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
}

