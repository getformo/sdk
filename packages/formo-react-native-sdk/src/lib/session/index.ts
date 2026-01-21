import {
  SESSION_WALLET_DETECTED_KEY,
  SESSION_WALLET_IDENTIFIED_KEY,
} from "../../constants";
import { storage } from "../storage";
import { logger } from "../logger";

export { SESSION_WALLET_DETECTED_KEY, SESSION_WALLET_IDENTIFIED_KEY };

/**
 * Session manager for tracking wallet detection and identification
 * Uses in-memory state that resets on app restart
 */
export class FormoAnalyticsSession {
  private detectedWallets: Set<string> = new Set();
  private identifiedWallets: Set<string> = new Set();

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Load session state from storage
   */
  private loadFromStorage(): void {
    try {
      const detected = storage().get(SESSION_WALLET_DETECTED_KEY);
      if (detected) {
        const parsed = JSON.parse(detected) as string[];
        this.detectedWallets = new Set(parsed);
      }

      const identified = storage().get(SESSION_WALLET_IDENTIFIED_KEY);
      if (identified) {
        const parsed = JSON.parse(identified) as string[];
        this.identifiedWallets = new Set(parsed);
      }
    } catch (error) {
      logger.debug("Session: Failed to load from storage", error);
    }
  }

  /**
   * Save session state to storage
   */
  private saveToStorage(): void {
    try {
      storage().set(
        SESSION_WALLET_DETECTED_KEY,
        JSON.stringify(Array.from(this.detectedWallets))
      );
      storage().set(
        SESSION_WALLET_IDENTIFIED_KEY,
        JSON.stringify(Array.from(this.identifiedWallets))
      );
    } catch (error) {
      logger.debug("Session: Failed to save to storage", error);
    }
  }

  /**
   * Check if a wallet has been detected in this session
   */
  public isWalletDetected(rdns: string): boolean {
    return this.detectedWallets.has(rdns);
  }

  /**
   * Mark a wallet as detected
   */
  public markWalletDetected(rdns: string): void {
    this.detectedWallets.add(rdns);
    this.saveToStorage();
  }

  /**
   * Check if a wallet + address combination has been identified
   */
  public isWalletIdentified(address: string, rdns: string): boolean {
    const key = `${address.toLowerCase()}:${rdns}`;
    return this.identifiedWallets.has(key);
  }

  /**
   * Mark a wallet + address combination as identified
   */
  public markWalletIdentified(address: string, rdns: string): void {
    const key = `${address.toLowerCase()}:${rdns}`;
    this.identifiedWallets.add(key);
    this.saveToStorage();
  }

  /**
   * Clear all session data
   */
  public clear(): void {
    this.detectedWallets.clear();
    this.identifiedWallets.clear();
    storage().remove(SESSION_WALLET_DETECTED_KEY);
    storage().remove(SESSION_WALLET_IDENTIFIED_KEY);
  }
}
