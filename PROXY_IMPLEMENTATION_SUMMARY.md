# Proxy Support Implementation Summary

## Overview

Added proxy support to the Formo SDK to bypass ad blockers by allowing events to be sent through user-configured proxy URLs instead of directly to `events.formo.so`.

## Changes Made

### 1. Type Definitions (`src/types/base.ts`)

Added `apiHost` option to the `Options` interface:

```typescript
export interface Options {
  // ... existing options
  /**
   * Custom API host for sending events through your own domain to bypass ad blockers
   * - If not provided, events are sent directly to events.formo.so
   * - When provided, events are sent to your custom endpoint which should forward them to Formo
   * - Example: 'https://your-host-url.com/ingest' or '/api/analytics'
   */
  apiHost?: string;
}
```

### 2. Event Queue (`src/lib/queue/EventQueue.ts`)

- Added `apiHost?: string` to the internal `Options` type
- Updated constructor to use custom API host if provided: `this.url = options.apiHost || options.url;`
- Added `credentials: 'include'` to fetch options to ensure cookies are sent with CORS requests

### 3. FormoAnalytics Class (`src/FormoAnalytics.ts`)

Updated EventManager initialization to pass the custom API host:

```typescript
this.eventManager = new EventManager(
  new EventQueue(this.config.writeKey, {
    url: EVENTS_API_URL,
    // ... other options
    apiHost: options.apiHost,
  })
);
```

### 4. Documentation

#### Created `PROXY.md`
Comprehensive documentation including:
- Overview of how proxy works
- Configuration examples for the SDK
- Proxy server implementations for:
  - Next.js (App Router and Pages Router)
  - Cloudflare Workers
  - Vercel Serverless Functions
  - Express.js / Node.js
- Security considerations
- Rate limiting examples
- CORS configuration
- Troubleshooting guide

#### Updated `README.md`
Added a "Proxy Support (Bypass Ad Blockers)" section with:
- Quick usage example
- Reference to the detailed PROXY.md documentation

## Usage Example

### SDK Configuration

```javascript
import { formofy } from '@formo/analytics';

formofy('your-write-key', {
  apiHost: 'https://your-host-url.com/ingest',  // Use your own domain
});
```

### React Provider

```tsx
import { FormoAnalyticsProvider } from '@formo/analytics';

<FormoAnalyticsProvider
  writeKey="your-write-key"
  options={{
    apiHost: 'https://your-host-url.com/ingest',
  }}
>
  {/* Your app */}
</FormoAnalyticsProvider>
```

## How It Works

### Without Proxy
```
Browser → events.formo.so ❌ (blocked by ad blocker)
```

### With Proxy
```
Browser → myapp.com/api/analytics ✅ → events.formo.so ✅
```

When an apiHost is configured:
1. The SDK sends all events to the configured proxy URL
2. The proxy server receives the request with the original Authorization header
3. The proxy forwards the request to `https://events.formo.so/v0/raw_events`
4. Formo receives and processes the events

## Benefits

1. **Bypass Ad Blockers**: Events are sent to your own domain, avoiding common ad blocker patterns
2. **Increased Data Collection**: More complete analytics even with privacy-focused users
3. **User Control**: Events appear to come from your domain, giving users more confidence
4. **Flexible Implementation**: Works with any server environment that can make HTTP requests

## Compatibility

- ✅ Fully backward compatible (optional feature)
- ✅ No breaking changes to existing APIs
- ✅ Works with all existing event types
- ✅ Supports both relative and absolute URLs

## Testing

The implementation has been built successfully with no TypeScript errors:

```bash
npm run build
✓ Built successfully
```

## Next Steps (Recommended)

1. **Add to CHANGELOG.md**: Document this as a new feature
2. **Update main documentation site**: Add proxy guide to docs.formo.so
3. **Consider adding examples** to the examples directory
4. **Monitor analytics**: Track proxy usage in production
5. **Add tests**: Create unit tests for proxy URL handling

## References

Based on implementations from:
- Plausible Analytics
- PostHog
- Simple Analytics
- Dub.co Introducing clicks tracking
- Pirsch Analytics
- Segment Analytics

All following industry-standard proxy patterns for bypassing ad blockers.
