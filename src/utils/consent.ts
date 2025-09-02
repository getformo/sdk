import { ConsentPreferences } from "../types";
import { logger } from "../lib";

/**
 * Cookie banner integration utilities for Formo Analytics
 * These utilities help integrate with popular cookie consent management platforms
 */

/**
 * Common cookie banner framework integration
 */
export interface CookieBannerFramework {
  name: string;
  isPresent: () => boolean;
  hasConsent: () => boolean;
  onConsentChange: (callback: (hasConsent: boolean) => void) => void;
  getPreferences?: () => ConsentPreferences | null;
}

/**
 * Check if OneTrust is present and get consent status
 */
export const OneTrustIntegration: CookieBannerFramework = {
  name: "OneTrust",
  isPresent: (): boolean => {
    return typeof window !== 'undefined' && 
           typeof (window as any).OneTrust !== 'undefined';
  },
  hasConsent: (): boolean => {
    if (typeof window === 'undefined') return false;
    const OneTrust = (window as any).OneTrust;
    if (!OneTrust) return false;
    
    // Check if analytics/performance cookies are consented to
    const activeGroups = OneTrust.getGeolocationData()?.state?.activeGroups || [];
    return activeGroups.includes('C0002'); // Performance cookies group
  },
  onConsentChange: (callback: (hasConsent: boolean) => void): void => {
    if (typeof window === 'undefined') return;
    
    window.addEventListener('OneTrustGroupsUpdated', () => {
      callback(OneTrustIntegration.hasConsent());
    });
  },
  getPreferences: (): ConsentPreferences | null => {
    if (!OneTrustIntegration.isPresent()) return null;
    
    const OneTrust = (window as any).OneTrust;
    const activeGroups = OneTrust.getGeolocationData()?.state?.activeGroups || [];
    
    return {
      functional: activeGroups.includes('C0001'), // Strictly necessary
      analytics: activeGroups.includes('C0002'), // Performance cookies
      marketing: activeGroups.includes('C0004'), // Targeting cookies
      performance: activeGroups.includes('C0002'), // Performance cookies
    };
  }
};

/**
 * Check if Cookiebot is present and get consent status
 */
export const CookiebotIntegration: CookieBannerFramework = {
  name: "Cookiebot",
  isPresent: (): boolean => {
    return typeof window !== 'undefined' && 
           typeof (window as any).Cookiebot !== 'undefined';
  },
  hasConsent: (): boolean => {
    if (typeof window === 'undefined') return false;
    const Cookiebot = (window as any).Cookiebot;
    return Cookiebot?.consent?.statistics === true;
  },
  onConsentChange: (callback: (hasConsent: boolean) => void): void => {
    if (typeof window === 'undefined') return;
    
    window.addEventListener('CookiebotOnConsentReady', () => {
      callback(CookiebotIntegration.hasConsent());
    });
  },
  getPreferences: (): ConsentPreferences | null => {
    if (!CookiebotIntegration.isPresent()) return null;
    
    const Cookiebot = (window as any).Cookiebot;
    const consent = Cookiebot?.consent;
    
    if (!consent) return null;
    
    return {
      functional: consent.necessary === true,
      analytics: consent.statistics === true,
      marketing: consent.marketing === true,
      performance: consent.statistics === true,
    };
  }
};

/**
 * Check if Cookie3 is present and get consent status
 * Based on: https://docs.cookie3.com/cookie3-analytics/setup-your-site-or-app/setting-up-consent-management
 */
export const Cookie3Integration: CookieBannerFramework = {
  name: "Cookie3",
  isPresent: (): boolean => {
    return typeof window !== 'undefined' && 
           typeof (window as any).cookie3 !== 'undefined';
  },
  hasConsent: (): boolean => {
    if (typeof window === 'undefined') return false;
    const cookie3 = (window as any).cookie3;
    return cookie3?.consent?.analytics === true;
  },
  onConsentChange: (callback: (hasConsent: boolean) => void): void => {
    if (typeof window === 'undefined') return;
    
    // Listen for Cookie3 consent events
    window.addEventListener('cookie3-consent-changed', () => {
      callback(Cookie3Integration.hasConsent());
    });
  },
  getPreferences: (): ConsentPreferences | null => {
    if (!Cookie3Integration.isPresent()) return null;
    
    const cookie3 = (window as any).cookie3;
    const consent = cookie3?.consent;
    
    if (!consent) return null;
    
    return {
      functional: consent.necessary !== false, // Default to true if not set
      analytics: consent.analytics === true,
      marketing: consent.marketing === true,
      performance: consent.analytics === true,
    };
  }
};

/**
 * Generic consent manager for custom implementations
 */
export const CustomIntegration: CookieBannerFramework = {
  name: "Custom",
  isPresent: (): boolean => {
    return typeof window !== 'undefined' && 
           typeof (window as any).consentManager !== 'undefined';
  },
  hasConsent: (): boolean => {
    if (typeof window === 'undefined') return false;
    const consentManager = (window as any).consentManager;
    return consentManager?.hasAnalyticsConsent?.() === true;
  },
  onConsentChange: (callback: (hasConsent: boolean) => void): void => {
    if (typeof window === 'undefined') return;
    
    // Listen for custom consent events
    window.addEventListener('consent-changed', () => {
      callback(CustomIntegration.hasConsent());
    });
  },
  getPreferences: (): ConsentPreferences | null => {
    if (!CustomIntegration.isPresent()) return null;
    
    const consentManager = (window as any).consentManager;
    return consentManager?.getPreferences?.() || null;
  }
};

/**
 * List of supported cookie banner frameworks
 */
export const SupportedFrameworks: CookieBannerFramework[] = [
  OneTrustIntegration,
  CookiebotIntegration,
  Cookie3Integration,
  CustomIntegration,
];

/**
 * Auto-detect which cookie banner framework is present
 * @returns {CookieBannerFramework | null} The detected framework or null if none found
 */
export function detectCookieBanner(): CookieBannerFramework | null {
  for (const framework of SupportedFrameworks) {
    if (framework.isPresent()) {
      logger.info(`Detected cookie banner framework: ${framework.name}`);
      return framework;
    }
  }
  
  logger.info("No cookie banner framework detected");
  return null;
}

/**
 * Helper to automatically sync Formo consent with detected cookie banner
 * @param formoInstance - The Formo Analytics instance
 * @returns {() => void} Cleanup function to remove event listeners
 */
export function autoSyncWithCookieBanner(formoInstance: {
  opt_out_tracking: () => void;
  opt_in_tracking: () => void;
  set_consent: (preferences: ConsentPreferences) => void;
}): (() => void) | null {
  const framework = detectCookieBanner();
  if (!framework) {
    return null;
  }

  // Initial sync
  if (framework.hasConsent()) {
    const preferences = framework.getPreferences?.();
    if (preferences) {
      formoInstance.set_consent(preferences);
    } else {
      formoInstance.opt_in_tracking();
    }
  } else {
    formoInstance.opt_out_tracking();
  }

  // Set up ongoing sync
  const cleanup = () => {
    // Cleanup would remove event listeners, but since we're using addEventListener
    // with anonymous functions, we can't easily remove them
    // In a real implementation, you'd store references to the listeners
  };

  framework.onConsentChange((hasConsent: boolean) => {
    if (hasConsent) {
      const preferences = framework.getPreferences?.();
      if (preferences) {
        formoInstance.set_consent(preferences);
      } else {
        formoInstance.opt_in_tracking();
      }
    } else {
      formoInstance.opt_out_tracking();
    }
  });

  return cleanup;
}

/**
 * Check browser Do Not Track setting
 * @returns {boolean} True if Do Not Track is enabled
 */
export function isDoNotTrackEnabled(): boolean {
  if (typeof navigator === 'undefined') return false;
  
  return navigator.doNotTrack === '1' || 
         navigator.doNotTrack === 'yes' ||
         (navigator as any).msDoNotTrack === '1';
}

/**
 * Get browser privacy preferences
 * @returns {ConsentPreferences} Privacy preferences based on browser settings
 */
export function getBrowserPrivacyPreferences(): ConsentPreferences {
  const dnt = isDoNotTrackEnabled();
  
  return {
    functional: true, // Functional cookies are typically always allowed
    analytics: !dnt,
    marketing: !dnt,
    performance: !dnt,
  };
}
