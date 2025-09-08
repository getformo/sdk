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

- **Opt-out/Opt-in tracking**: Similar to Mixpanel's consent functions
- **Analytics consent preferences**: Control analytics tracking consent
- **Simple binary controls**: Just enable or disable tracking

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

// Opt back into tracking (re-enables analytics)
analytics.optInTracking();
```

### Simple Consent Management

```javascript
// Simple binary consent controls
analytics.optInTracking();           // Enable analytics tracking
analytics.optOutTracking();          // Disable analytics tracking

// Check current consent status
if (!analytics.hasOptedOutTracking()) {
  console.log('Analytics tracking is enabled');
}

// Clear consent state (resets to default)
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


#### `clearConsent()`
Clears the opt-out flag and resets consent state to default.

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
      const instance = await FormoAnalytics.init('your-write-key');
      
      setAnalytics(instance);
      setHasConsent(!instance.hasOptedOutTracking());
    }
    
    initAnalytics();
  }, []);

  const handleAcceptCookies = () => {
    analytics?.optInTracking();
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
    this.analytics = await FormoAnalytics.init('your-write-key');
    
    this.hasConsent = !this.analytics.hasOptedOutTracking();
  },
  
  methods: {
    handleAccept() {
      this.analytics?.optInTracking();
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
    return FormoAnalytics.init('your-write-key');
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

1. **Obtaining explicit consent**: Use `optInTracking()` to record explicit user choices
2. **Honoring opt-out requests**: `optOutTracking()` immediately stops data collection
3. **Data minimization**: Only tracks when consent is given
4. **Right to withdraw**: Users can revoke consent at any time with `optOutTracking()`

```javascript
// GDPR-compliant implementation
if (userExplicitlyConsented) {
  analytics.optInTracking();  // Only opt in if user explicitly agreed
} else {
  analytics.optOutTracking(); // Default to opted out for privacy
}
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
