# Consent Management with Formo Analytics SDK

The Formo Analytics SDK includes comprehensive consent management functionality to help you comply with privacy regulations like GDPR, CCPA, and ePrivacy Directive. This guide explains how to integrate consent management with your existing cookie banners and implement privacy-compliant analytics.

## Table of Contents

- [Overview](#overview)
- [Basic Usage](#basic-usage)
- [Cookie Banner Integration](#cookie-banner-integration)
- [Configuration Options](#configuration-options)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Privacy Compliance](#privacy-compliance)

## Overview

The consent management system provides:

- **Opt-out tracking**: Similar to Mixpanel's `opt_out_tracking()` function
- **Granular consent preferences**: Control different types of tracking (analytics, marketing, etc.)
- **Cookie banner integration**: Automatic sync with popular consent management platforms
- **Privacy-friendly storage**: Switches to memory storage when consent is denied
- **Do Not Track support**: Respects browser privacy preferences

## Basic Usage

### Simple Opt-Out/Opt-In

```javascript
import { FormoAnalytics } from '@formo/analytics';

const analytics = await FormoAnalytics.init('your-write-key');

// Check if user has opted out
if (!analytics.has_opted_out_tracking()) {
  // User has not opted out, tracking is enabled
  analytics.track('page_view');
}

// Opt out of tracking (stops all analytics)
analytics.opt_out_tracking();

// Opt back in to tracking
analytics.opt_in_tracking();
```

### Granular Consent Management

```javascript
// Set detailed consent preferences
analytics.set_consent({
  analytics: true,     // Allow analytics tracking
  marketing: false,    // Deny marketing tracking
  functional: true,    // Allow functional cookies
  performance: true    // Allow performance tracking
});

// Get current consent preferences
const consent = analytics.get_consent();
console.log('Analytics consent:', consent?.analytics);

// Clear all consent preferences
analytics.clear_consent();
```

## Cookie Banner Integration

### Automatic Detection and Sync

The SDK can automatically detect and sync with popular cookie banner frameworks:

```javascript
const analytics = await FormoAnalytics.init('your-write-key', {
  consent: {
    autoDetectBanners: true,  // Automatically detect and sync with cookie banners
    respectDNT: true         // Respect Do Not Track browser setting
  }
});

// Manually enable cookie banner sync
const cleanup = analytics.enableCookieBannerSync();

// Clean up event listeners when component unmounts
// cleanup?.();
```

### Supported Cookie Banner Frameworks

The SDK supports the following cookie consent management platforms:

#### OneTrust

```javascript
// OneTrust integration works automatically
// The SDK listens for OneTrust consent events and maps categories:
// - C0001: Strictly Necessary (functional)
// - C0002: Performance Cookies (analytics/performance)
// - C0004: Targeting Cookies (marketing)
```

#### Cookiebot

```javascript
// Cookiebot integration works automatically
// Maps Cookiebot categories to Formo consent preferences:
// - necessary: functional
// - statistics: analytics/performance  
// - marketing: marketing
```

#### Cookie3

```javascript
// Cookie3 integration based on their documentation
// Listens for 'cookie3-consent-changed' events
// Uses window.cookie3.consent object for preferences
```

#### Custom Implementation

For custom cookie banner implementations:

```javascript
// Set up a global consent manager
window.consentManager = {
  hasAnalyticsConsent: () => {
    // Your logic to check analytics consent
    return localStorage.getItem('analytics_consent') === 'true';
  },
  
  getPreferences: () => {
    // Return consent preferences object
    return {
      analytics: localStorage.getItem('analytics_consent') === 'true',
      marketing: localStorage.getItem('marketing_consent') === 'true',
      functional: true,
      performance: localStorage.getItem('performance_consent') === 'true'
    };
  }
};

// Dispatch events when consent changes
function updateConsent(preferences) {
  // Update your storage
  localStorage.setItem('analytics_consent', preferences.analytics);
  
  // Notify Formo SDK
  window.dispatchEvent(new Event('consent-changed'));
}
```

### Manual Integration

If you prefer manual integration with your existing cookie banner:

```javascript
// Your existing cookie banner callback
function onConsentUpdate(consentData) {
  // Map your consent data to Formo preferences
  const formoConsent = {
    analytics: consentData.analytics_cookies,
    marketing: consentData.marketing_cookies,
    functional: consentData.necessary_cookies,
    performance: consentData.performance_cookies
  };
  
  // Update Formo consent
  analytics.set_consent(formoConsent);
}

// Your existing opt-out handler
function onOptOut() {
  analytics.opt_out_tracking();
}

// Your existing opt-in handler  
function onOptIn() {
  analytics.opt_in_tracking();
}
```

## Configuration Options

### Consent Options

```javascript
interface ConsentOptions {
  respectDNT?: boolean;           // Respect Do Not Track header (default: false)
  defaultStorage?: 'memory' | 'localStorage' | 'sessionStorage';  // Storage when no consent
  autoDetectBanners?: boolean;    // Auto-detect cookie banners (default: false)
}

const analytics = await FormoAnalytics.init('your-write-key', {
  consent: {
    respectDNT: true,
    defaultStorage: 'memory',
    autoDetectBanners: true
  }
});
```

### Consent Preferences

```javascript
interface ConsentPreferences {
  analytics?: boolean;    // Analytics and performance tracking
  marketing?: boolean;    // Marketing and advertising cookies
  functional?: boolean;   // Functional/necessary cookies
  performance?: boolean;  // Performance and optimization tracking
}
```

## API Reference

### Consent Management Methods

#### `opt_out_tracking()`
Opts the user out of all tracking. Stops analytics collection and switches to memory storage.

```javascript
analytics.opt_out_tracking();
```

#### `opt_in_tracking()`
Opts the user back into tracking. Re-enables analytics collection and cookie storage.

```javascript
analytics.opt_in_tracking();
```

#### `has_opted_out_tracking(): boolean`
Returns whether the user has opted out of tracking.

```javascript
if (analytics.has_opted_out_tracking()) {
  console.log('User has opted out');
}
```

#### `set_consent(preferences: ConsentPreferences)`
Sets detailed consent preferences for different types of tracking.

```javascript
analytics.set_consent({
  analytics: true,
  marketing: false,
  functional: true,
  performance: true
});
```

#### `get_consent(): ConsentPreferences | null`
Gets the current consent preferences.

```javascript
const consent = analytics.get_consent();
if (consent?.analytics) {
  console.log('Analytics tracking is consented');
}
```

#### `clear_consent()`
Clears all consent preferences and opt-out flags.

```javascript
analytics.clear_consent();
```

#### `enableCookieBannerSync(): (() => void) | null`
Enables automatic synchronization with cookie banner frameworks.

```javascript
const cleanup = analytics.enableCookieBannerSync();
// Call cleanup() to remove event listeners
```

#### `detectCookieBannerFramework(): string | null`
Detects which cookie banner framework is present on the page.

```javascript
const framework = analytics.detectCookieBannerFramework();
console.log('Detected framework:', framework);
```

## Examples

### React Integration

```jsx
import React, { useEffect, useState } from 'react';
import { FormoAnalytics } from '@formo/analytics';

function App() {
  const [analytics, setAnalytics] = useState(null);
  const [hasConsent, setHasConsent] = useState(false);

  useEffect(() => {
    async function initAnalytics() {
      const instance = await FormoAnalytics.init('your-write-key', {
        consent: {
          autoDetectBanners: true,
          respectDNT: true
        }
      });
      
      setAnalytics(instance);
      setHasConsent(!instance.has_opted_out_tracking());
    }
    
    initAnalytics();
  }, []);

  const handleAcceptCookies = () => {
    analytics?.set_consent({
      analytics: true,
      marketing: true,
      functional: true,
      performance: true
    });
    setHasConsent(true);
  };

  const handleRejectCookies = () => {
    analytics?.opt_out_tracking();
    setHasConsent(false);
  };

  return (
    <div>
      {!hasConsent && (
        <div className="cookie-banner">
          <p>We use cookies to improve your experience.</p>
          <button onClick={handleAcceptCookies}>Accept All</button>
          <button onClick={handleRejectCookies}>Reject All</button>
        </div>
      )}
      
      <main>
        {/* Your app content */}
      </main>
    </div>
  );
}
```

### Vue.js Integration

```vue
<template>
  <div>
    <CookieBanner 
      v-if="!hasConsent" 
      @accept="handleAccept"
      @reject="handleReject"
    />
    
    <main>
      <!-- Your app content -->
    </main>
  </div>
</template>

<script>
import { FormoAnalytics } from '@formo/analytics';

export default {
  data() {
    return {
      analytics: null,
      hasConsent: false
    }
  },
  
  async mounted() {
    this.analytics = await FormoAnalytics.init('your-write-key', {
      consent: {
        autoDetectBanners: true
      }
    });
    
    this.hasConsent = !this.analytics.has_opted_out_tracking();
  },
  
  methods: {
    handleAccept() {
      this.analytics?.opt_in_tracking();
      this.hasConsent = true;
    },
    
    handleReject() {
      this.analytics?.opt_out_tracking();
      this.hasConsent = false;
    }
  }
}
</script>
```

### Server-Side Rendering (SSR)

```javascript
// For SSR frameworks like Next.js, check for browser environment
function initializeAnalytics() {
  if (typeof window !== 'undefined') {
    return FormoAnalytics.init('your-write-key', {
      consent: {
        autoDetectBanners: true,
        respectDNT: true
      }
    });
  }
  return null;
}

// In your component
useEffect(() => {
  initializeAnalytics().then(analytics => {
    if (analytics) {
      // Analytics is ready
      setAnalyticsInstance(analytics);
    }
  });
}, []);
```

## Privacy Compliance

### GDPR Compliance

The consent management system helps with GDPR compliance by:

1. **Obtaining explicit consent**: Use `set_consent()` to record explicit user choices
2. **Honoring opt-out requests**: `opt_out_tracking()` immediately stops data collection
3. **Data minimization**: Only tracks when consent is given
4. **Right to withdraw**: Users can revoke consent at any time

```javascript
// GDPR-compliant implementation
analytics.set_consent({
  analytics: userExplicitlyConsented,  // Only true if user explicitly agreed
  marketing: false,                    // Start with strict settings
  functional: true,                    // Necessary cookies for site function
  performance: userExplicitlyConsented
});
```

### CCPA Compliance

For CCPA compliance:

```javascript
// Provide opt-out option for California residents
function handleCCPAOptOut() {
  analytics.opt_out_tracking();
  
  // Show confirmation to user
  alert('You have opted out of data collection');
}

// Check if user is from California and show opt-out link
if (userLocation === 'CA') {
  showOptOutLink(handleCCPAOptOut);
}
```

### ePrivacy Directive (Cookie Law)

The SDK helps comply with cookie law requirements:

1. **Cookie consent**: Automatically switches to memory storage without consent
2. **Strictly necessary exception**: Functional cookies can be enabled by default
3. **Clear information**: Granular control over different cookie types

```javascript
// Cookie law compliant setup
analytics.set_consent({
  functional: true,    // Strictly necessary cookies don't need consent
  analytics: false,    // Analytics cookies need consent
  marketing: false,    // Marketing cookies need consent
  performance: false   // Performance cookies need consent
});

// Only enable after user consents
function onCookieConsent() {
  analytics.set_consent({
    functional: true,
    analytics: true,
    marketing: userConsentedToMarketing,
    performance: true
  });
}
```

### Storage Behavior

When consent is denied, the SDK automatically:

1. **Switches to memory storage**: No persistent cookies are set
2. **Clears existing data**: Removes previously stored analytics data
3. **Stops tracking**: No events are sent to analytics servers
4. **Maintains functionality**: Core SDK functions still work without tracking

This ensures that your application continues to function even when users opt out of tracking.

## Best Practices

1. **Always check consent status**: Use `has_opted_out_tracking()` before tracking events
2. **Respect user preferences**: Honor consent choices immediately
3. **Provide clear opt-out**: Make it easy for users to change their mind
4. **Test thoroughly**: Verify consent handling works with your cookie banner
5. **Document your usage**: Keep records of how you handle consent for compliance

## Troubleshooting

### Common Issues

**Cookie banner not detected**
- Ensure the banner framework is loaded before initializing Formo
- Check browser console for framework detection logs
- Try manual integration if auto-detection fails

**Consent not persisting**
- Verify cookies are enabled in the browser
- Check if your domain allows third-party cookies
- Ensure consent preferences are set correctly

**Tracking still happening after opt-out**
- Verify `shouldTrack()` method is being called
- Check for any cached analytics instances
- Clear browser storage and test again

For additional support, please refer to the main Formo Analytics documentation or contact support.
