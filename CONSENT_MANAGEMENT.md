# Consent Management with Formo Analytics SDK

The Formo Analytics SDK includes simplified consent management functionality to help you comply with privacy regulations like GDPR, CCPA, and ePrivacy Directive. This guide explains how to implement privacy-compliant analytics tracking.

## Table of Contents

- [Overview](#overview)
- [Basic Usage](#basic-usage)
- [Configuration Options](#configuration-options)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Privacy Compliance](#privacy-compliance)

## Overview

The simplified consent management system provides:

- **Opt-out tracking**: Similar to Mixpanel's `optOutTracking()` function
- **Granular consent preferences**: Control different types of tracking (analytics, marketing, etc.)
- **Privacy-friendly storage**: Switches to memory storage when consent is denied
- **Do Not Track support**: Respects browser privacy preferences

## Basic Usage

### Simple Opt-Out

```javascript
import { FormoAnalytics } from '@formo/analytics';

const analytics = await FormoAnalytics.init('your-write-key');

// Check if user has opted out
if (!analytics.hasOptedOutTracking()) {
  // User has not opted out, tracking is enabled
  analytics.track('page_view');
}

// Opt out of tracking (stops all analytics)
analytics.optOutTracking();

// To opt back in, clear the opt-out and set consent
analytics.clearConsent();
analytics.setConsent({ analytics: true });
```

### Granular Consent Management

```javascript
// Set detailed consent preferences
analytics.setConsent({
  analytics: true,     // Allow analytics tracking
  marketing: false,    // Deny marketing tracking
  functional: true,    // Allow functional cookies
  performance: true    // Allow performance tracking
});

// Get current consent preferences
const consent = analytics.getConsent();
console.log('Analytics consent:', consent?.analytics);

// Clear all consent preferences
analytics.clearConsent();
```

## Manual Integration with Cookie Banners

You can manually integrate with your existing cookie banner:

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
  analytics.setConsent(formoConsent);
}

// Your existing opt-out handler
function onOptOut() {
  analytics.optOutTracking();
}

// Your existing consent acceptance handler  
function onAcceptConsent() {
  analytics.setConsent({
    analytics: true,
    marketing: true,
    functional: true,
    performance: true
  });
}
```

## Configuration Options

### SDK Options

```javascript
const analytics = await FormoAnalytics.init('your-write-key', {
  respectDNT: true,  // Respect Do Not Track header (default: false)
  tracking: true     // Enable/disable tracking (default: true except localhost)
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

#### `optOutTracking()`
Opts the user out of all tracking. Stops analytics collection and switches to memory storage.

```javascript
analytics.optOutTracking();
```

#### `hasOptedOutTracking(): boolean`
Returns whether the user has opted out of tracking.

```javascript
if (analytics.hasOptedOutTracking()) {
  console.log('User has opted out');
}
```

#### `setConsent(preferences: ConsentPreferences)`
Sets detailed consent preferences for different types of tracking.

```javascript
analytics.setConsent({
  analytics: true,
  marketing: false,
  functional: true,
  performance: true
});
```

#### `getConsent(): ConsentPreferences | null`
Gets the current consent preferences.

```javascript
const consent = analytics.getConsent();
if (consent?.analytics) {
  console.log('Analytics tracking is consented');
}
```

#### `clearConsent()`
Clears all consent preferences and opt-out flags.

```javascript
analytics.clearConsent();
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
        respectDNT: true
      });
      
      setAnalytics(instance);
      setHasConsent(!instance.hasOptedOutTracking());
    }
    
    initAnalytics();
  }, []);

  const handleAcceptCookies = () => {
    analytics?.setConsent({
      analytics: true,
      marketing: true,
      functional: true,
      performance: true
    });
    setHasConsent(true);
  };

  const handleRejectCookies = () => {
    analytics?.optOutTracking();
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
      respectDNT: true
    });
    
    this.hasConsent = !this.analytics.hasOptedOutTracking();
  },
  
  methods: {
    handleAccept() {
      this.analytics?.setConsent({
        analytics: true,
        marketing: true,
        functional: true,
        performance: true
      });
      this.hasConsent = true;
    },
    
    handleReject() {
      this.analytics?.optOutTracking();
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
      respectDNT: true
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
analytics.setConsent({
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
  analytics.optOutTracking();
  
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
analytics.setConsent({
  functional: true,    // Strictly necessary cookies don't need consent
  analytics: false,    // Analytics cookies need consent
  marketing: false,    // Marketing cookies need consent
  performance: false   // Performance cookies need consent
});

// Only enable after user consents
function onCookieConsent() {
  analytics.setConsent({
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

1. **Always check consent status**: Use `hasOptedOutTracking()` before tracking events
2. **Respect user preferences**: Honor consent choices immediately
3. **Provide clear opt-out**: Make it easy for users to change their mind
4. **Test thoroughly**: Verify consent handling works with your cookie banner
5. **Document your usage**: Keep records of how you handle consent for compliance

## Troubleshooting

### Common Issues

**Manual integration needed**
- Use the provided manual integration examples
- Set up consent handling in your existing cookie banner callbacks

**Consent not persisting**
- Verify cookies are enabled in the browser
- Check if your domain allows third-party cookies
- Ensure consent preferences are set correctly

**Tracking still happening after opt-out**
- Verify `shouldTrack()` method is being called
- Check for any cached analytics instances
- Clear browser storage and test again

For additional support, please refer to the main Formo Analytics documentation or contact support.
