/**
 * Session management for Formo Analytics
 * 
 * Handles tracking of detected wallets and identified wallet-address pairs
 * using cookies to maintain state across page loads within a session.
 */

import { cookie } from "../storage";
import { getIdentityCookieSecurity } from "../storage/cookiePolicy";
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
   * @param userId Optional external user ID (e.g. a Privy DID). When provided,
   *   it is folded into the dedup key so attaching a new user ID to an
   *   already-identified wallet re-emits instead of being silently deduped.
   */
  isWalletIdentified(address: string, rdns: string, userId?: string): boolean;

  /**
   * Mark a wallet-address pair as identified in this session
   * @param address The wallet address
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   * @param userId Optional external user ID (e.g. a Privy DID). See
   *   {@link isWalletIdentified} for how it affects the dedup key.
   */
  markWalletIdentified(address: string, rdns: string, userId?: string): void;
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
const MAX_SESSION_ENTRIES = 20;

export class FormoAnalyticsSession implements IFormoAnalyticsSession {
  /**
   * Generate a unique key for wallet identification tracking
   * Combines address, RDNS, and (optionally) the external user ID to track
   * specific wallet-address-user combinations.
   *
   * Folding the user ID into the key means the same wallet identified first
   * anonymously and later with a user ID (e.g. after a Privy login attaches a
   * DID) produces two distinct keys, so the second identify is not deduped.
   * When `userId` is omitted the key is unchanged (`address` or `address:rdns`),
   * preserving backward compatibility with keys already stored in browsers.
   *
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   * @param userId Optional external user ID (e.g. a Privy DID)
   * @returns A unique identification key
   */
  private generateIdentificationKey(
    address: string,
    rdns: string,
    userId?: string
  ): string {
    // Percent-encode each component before joining. The identified-wallet list
    // is persisted comma-joined in a cookie and later split on commas, so a raw
    // comma in an arbitrary external userId would corrupt the key and defeat
    // dedup (the same identify would re-emit on every call). Encoding also keeps
    // the ":" separator unambiguous. Addresses and RDNS contain no reserved
    // characters, so their encoded form is unchanged — existing stored keys
    // still match (backward compatible).
    const parts = [encodeURIComponent(address)];
    if (rdns) parts.push(encodeURIComponent(rdns));
    if (userId) parts.push(encodeURIComponent(userId));
    return parts.join(":");
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
      if (rdnses.length > MAX_SESSION_ENTRIES) {
        rdnses.splice(0, rdnses.length - MAX_SESSION_ENTRIES);
      }
      cookie().set(SESSION_WALLET_DETECTED_KEY, rdnses.join(","), {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
        ...getIdentityCookieSecurity(),
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
  public isWalletIdentified(
    address: string,
    rdns: string,
    userId?: string
  ): boolean {
    const identifiedKey = this.generateIdentificationKey(address, rdns, userId);
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
  public markWalletIdentified(
    address: string,
    rdns: string,
    userId?: string
  ): void {
    const identifiedKey = this.generateIdentificationKey(address, rdns, userId);
    const identifiedWallets =
      cookie().get(SESSION_WALLET_IDENTIFIED_KEY)?.split(",") || [];
    const alreadyExists = identifiedWallets.includes(identifiedKey);

    if (!alreadyExists) {
      identifiedWallets.push(identifiedKey);
      if (identifiedWallets.length > MAX_SESSION_ENTRIES) {
        identifiedWallets.splice(0, identifiedWallets.length - MAX_SESSION_ENTRIES);
      }
      const newValue = identifiedWallets.join(",");
      cookie().set(SESSION_WALLET_IDENTIFIED_KEY, newValue, {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
        ...getIdentityCookieSecurity(),
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

