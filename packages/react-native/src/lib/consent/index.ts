import { storage } from "../storage";
import { hash } from "../../utils/hash";
import { logger } from "../logger";

/**
 * Get a hashed key for consent storage
 */
function getConsentKey(writeKey: string, key: string): string {
  // Use a simple hash of the writeKey for privacy
  const hashedKey = writeKey.slice(0, 8);
  return `consent_${hashedKey}_${key}`;
}

/**
 * Set a consent flag
 */
export function setConsentFlag(
  writeKey: string,
  key: string,
  value: string
): void {
  try {
    const consentKey = getConsentKey(writeKey, key);
    storage().set(consentKey, value);
  } catch (error) {
    logger.error("Consent: Failed to set flag", error);
  }
}

/**
 * Get a consent flag
 */
export function getConsentFlag(writeKey: string, key: string): string | null {
  try {
    const consentKey = getConsentKey(writeKey, key);
    return storage().get(consentKey);
  } catch (error) {
    logger.error("Consent: Failed to get flag", error);
    return null;
  }
}

/**
 * Remove a consent flag
 */
export function removeConsentFlag(writeKey: string, key: string): void {
  try {
    const consentKey = getConsentKey(writeKey, key);
    storage().remove(consentKey);
  } catch (error) {
    logger.error("Consent: Failed to remove flag", error);
  }
}
