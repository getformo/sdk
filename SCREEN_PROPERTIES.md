# Screen Properties Implementation

## Overview

Screen properties have been added to the Formo Analytics SDK to match industry standards from RudderStack and Segment. These properties provide detailed information about the user's display environment.

## Implementation

### Screen Properties Collected

The SDK now automatically collects the following screen properties as **flat fields** in every event's `context` object:

```typescript
{
  screen_width: number;      // Total screen width in pixels (screen.width)
  screen_height: number;     // Total screen height in pixels (screen.height)
  screen_density: number;    // Pixel density ratio (devicePixelRatio)
  viewport_width: number;    // Browser viewport width in pixels (window.innerWidth)
  viewport_height: number;   // Browser viewport height in pixels (window.innerHeight)
}
```

### Enhanced Implementation

| Platform | Properties |
|----------|-----------|
| **RudderStack** | width, height, density |
| **Segment** | width, height, density |
| **Formo** | width, height, density, **innerWidth**, **innerHeight** |

Formo includes the standard RudderStack/Segment properties **plus** additional `innerWidth` and `innerHeight` properties to capture the actual browser viewport size, addressing the discussion in [Plausible Analytics #1025](https://github.com/plausible/analytics/discussions/1025) about tracking browser window size vs. screen size.

## Usage Example

### Event Payload Structure

When you send an event, the screen properties are automatically included in the context:

```javascript
{
  "type": "page",
  "anonymous_id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": null,
  "address": null,
  "channel": "web",
  "version": "1.0.0",
  "original_timestamp": "2025-11-03T10:30:00.000Z",
  "context": {
    "user_agent": "Mozilla/5.0...",
    "locale": "en-US",
    "timezone": "America/New_York",
    "location": "US",
    "page_path": "/",
    "page_title": "Home",
    "page_url": "https://example.com/",
    "library_name": "Formo Web SDK",
    "library_version": "1.22.0",
    "browser": "chrome",
    "screen_width": 1920,
    "screen_height": 1080,
    "screen_density": 2,
    "viewport_width": 1680,
    "viewport_height": 937
  },
  "properties": {
    "url": "https://example.com/",
    "path": "/",
    "hash": ""
  }
}
```

## Use Cases

### 1. Responsive Design Optimization
Use screen dimensions to understand what breakpoints your users actually experience:

```javascript
// Analyze viewport sizes to optimize responsive design
const viewportSizes = events.map(e => ({
  width: e.context.viewport_width,
  height: e.context.viewport_height
}));
```

### 2. Device Type Inference
Combine screen size with density to better understand device types:

```javascript
function inferDeviceType(context) {
  const { viewport_width, screen_density } = context;
  
  if (viewport_width < 768) return 'mobile';
  if (viewport_width < 1024) return 'tablet';
  if (screen_density >= 2) return 'retina-desktop';
  return 'desktop';
}
```

### 3. High-DPI Display Detection
Identify users with high-DPI displays for optimized asset delivery:

```javascript
if (context.screen_density >= 2) {
  // User has a Retina or high-DPI display
  // Serve 2x images
}
```

### 4. True Viewport vs Screen Size Analysis
Understand how users actually view your site (fullscreen vs windowed):

```javascript
const viewportUtilization = {
  widthRatio: context.viewport_width / context.screen_width,
  heightRatio: context.viewport_height / context.screen_height,
  isFullscreen: context.viewport_width === context.screen_width
};
```

## Browser Compatibility

The implementation includes fallback values for maximum compatibility:

- `screen.width` / `screen.height`: Supported in all modern browsers
- `window.devicePixelRatio`: Supported in all modern browsers, defaults to 1
- `window.innerWidth` / `window.innerHeight`: Supported in all modern browsers, defaults to 0

## Privacy Considerations

Screen properties provide device-level information without identifying individual users. This data:

- ✅ Helps optimize user experience through responsive design
- ✅ Is automatically collected by most analytics platforms
- ✅ Does not require additional user consent (device information)
- ✅ Cannot be used to identify individual users

## References

- [RudderStack Event Spec - Common Fields](https://www.rudderstack.com/docs/event-spec/standard-events/common-fields/)
- [Segment Analytics Spec - Common](https://segment.com/docs/connections/spec/common/)
- [Plausible Analytics Discussion #1025 - Screen Size Info](https://github.com/plausible/analytics/discussions/1025)

## Changes Made

### Modified Files

1. **`src/lib/event/EventFactory.ts`**
   - Added `getScreen()` method to collect screen properties
   - Updated `generateContext()` to include screen data in all events

### Example Comparison

**Before:**
```javascript
{
  "context": {
    "user_agent": "...",
    "locale": "en-US",
    "browser": "chrome"
    // No screen properties
  }
}
```

**After:**
```javascript
{
  "context": {
    "user_agent": "...",
    "locale": "en-US",
    "browser": "chrome",
    "screen_width": 1920,
    "screen_height": 1080,
    "screen_density": 2,
    "viewport_width": 1680,
    "viewport_height": 937
  }
}
```

## Technical Details

### Implementation Location

The screen properties are collected in the `EventFactory` class within the `generateContext()` method. This ensures all events automatically include screen information without requiring manual instrumentation.

### Error Handling

The implementation includes comprehensive error handling:

```typescript
private getScreen() {
  try {
    return {
      screen_width: globalThis.screen?.width || 0,
      screen_height: globalThis.screen?.height || 0,
      screen_density: globalThis.devicePixelRatio || 1,
      viewport_width: globalThis.innerWidth || 0,
      viewport_height: globalThis.innerHeight || 0,
    };
  } catch (error) {
    logger.error("Error resolving screen properties:", error);
    return {
      screen_width: 0,
      screen_height: 0,
      screen_density: 1,
      viewport_width: 0,
      viewport_height: 0,
    };
  }
}
```

### Performance Impact

- **Memory**: Adds ~100 bytes per event (5 numeric properties)
- **CPU**: Minimal - screen properties are read once per event
- **Network**: Negligible increase in payload size (~100 bytes)

## Testing

The implementation has been built and compiled successfully. To test in your application:

```javascript
import { FormoAnalytics } from '@formo/analytics';

const formo = new FormoAnalytics({ writeKey: 'your-write-key' });

// Send a page view - screen properties will be automatically included
await formo.page();

// Check console/network to see the event payload with screen properties
```

## Backward Compatibility

This change is **fully backward compatible**:
- ✅ No breaking changes to the API
- ✅ Existing events continue to work
- ✅ New properties are added automatically
- ✅ No migration required

## Next Steps

Consider these enhancements for future iterations:

1. **Screen Orientation**: Add `orientation` property (portrait/landscape)
2. **Color Depth**: Add `colorDepth` property for display capabilities
3. **Touch Support**: Add `touchSupported` boolean
4. **Screen Resolution Categories**: Automatically categorize screens (HD, Full HD, 4K, etc.)

---

**Version**: 1.22.0+
**Date**: November 3, 2025
**Status**: ✅ Implemented and Built

