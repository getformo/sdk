# Referral Configuration Examples

This document provides practical examples for testing custom referral parameter parsing in your local app.

## Quick Test URLs

### Default Behavior (No Configuration)
The SDK automatically captures these without any configuration:
```
http://localhost:3000?ref=ABC123
http://localhost:3000?referral=XYZ789
http://localhost:3000?refcode=USER001
```

## Example Configurations

### Example 1: Custom Query Parameters

```typescript
import { FormoAnalytics } from '@formo/analytics';

FormoAnalytics.init('your-write-key', {
  referral: {
    queryParams: ['via', 'source', 'partner']
  }
});
```

**Test URLs:**
```
http://localhost:3000?via=INFLUENCER123
http://localhost:3000?source=TWITTER_CAMPAIGN
http://localhost:3000?partner=ACME_CORP
```

### Example 2: URL Path Patterns (Like Glider.fi)

```typescript
FormoAnalytics.init('your-write-key', {
  referral: {
    pathPatterns: ['/r/([^/]+)']
  }
});
```

**Test URLs:**
```
http://localhost:3000/r/01K17FKB
http://localhost:3000/r/ABC123XYZ
http://localhost:3000/r/user-referral-code
```

### Example 3: Multiple Path Patterns

```typescript
FormoAnalytics.init('your-write-key', {
  referral: {
    pathPatterns: [
      '/r/([^/]+)',           // /r/CODE
      '/invite/([^/]+)',      // /invite/CODE
      '/join/([^/]+)',        // /join/CODE
    ]
  }
});
```

**Test URLs:**
```
http://localhost:3000/r/ABC123
http://localhost:3000/invite/FRIEND456
http://localhost:3000/join/TEAM789
```

### Example 4: Combined Query Params + Path Patterns

```typescript
FormoAnalytics.init('your-write-key', {
  referral: {
    queryParams: ['via', 'ref'],
    pathPatterns: ['/r/([^/]+)', '/referral/([^/]+)']
  }
});
```

**Test URLs:**
```
http://localhost:3000?via=TWITTER          → Captures: TWITTER (query param)
http://localhost:3000?ref=PARTNER          → Captures: PARTNER (query param)
http://localhost:3000/r/CODE123            → Captures: CODE123 (path pattern)
http://localhost:3000/referral/AFFILIATE   → Captures: AFFILIATE (path pattern)
http://localhost:3000/r/PATH?via=QUERY     → Captures: QUERY (query takes priority)
```

**Priority:** Query parameters are checked first, then path patterns. This allows flexible referral tracking across different URL formats.

### Example 5: Strict Alphanumeric Codes

```typescript
FormoAnalytics.init('your-write-key', {
  referral: {
    pathPatterns: [
      '/promo/([A-Z0-9]{6})',        // Exactly 6 uppercase alphanumeric chars
      '/campaign/([a-z]{3}-[0-9]{4})', // Format: abc-1234
    ]
  }
});
```

**Test URLs:**
```
http://localhost:3000/promo/ABC123
http://localhost:3000/campaign/xyz-5678
```

### Example 6: Nested Path Patterns

```typescript
FormoAnalytics.init('your-write-key', {
  referral: {
    pathPatterns: [
      '/refer/([^/]+)/signup',        // /refer/CODE/signup
      '/u/([^/]+)/invite',            // /u/USERNAME/invite
    ]
  }
});
```

**Test URLs:**
```
http://localhost:3000/refer/ALICE123/signup
http://localhost:3000/u/bob_smith/invite
```

## Testing in Your Local App

### React Example

```tsx
import { FormoAnalytics } from '@formo/analytics';
import { useEffect } from 'react';

function App() {
  useEffect(() => {
    FormoAnalytics.init('your-write-key', {
      referral: {
        queryParams: ['via', 'source'],
        pathPatterns: ['/r/([^/]+)']
      }
    });
  }, []);

  return <div>Your App</div>;
}
```

### Testing Steps

1. Start your local app
2. Navigate to test URLs with referral codes
3. Check browser console for Formo logs (enable with `logger: { enabled: true }`)
4. Verify in Formo dashboard that `ref` field is captured

### Debugging

Enable logging to see referral parsing in action:

```typescript
FormoAnalytics.init('your-write-key', {
  logger: {
    enabled: true,
    levels: ['info', 'warn', 'error']
  },
  referral: {
    queryParams: ['via'],
    pathPatterns: ['/r/([^/]+)']
  }
});
```

Then check your browser console for messages about traffic sources and referral codes.

## Common Use Cases

### Influencer Tracking
```typescript
referral: {
  queryParams: ['influencer', 'creator', 'channel'],
  pathPatterns: ['/c/([^/]+)']  // /c/INFLUENCER_NAME
}
```

### Affiliate Programs
```typescript
referral: {
  queryParams: ['aff', 'affiliate', 'partner'],
  pathPatterns: ['/aff/([A-Z0-9]+)']  // /aff/AFF123
}
```

### Social Media Campaigns
```typescript
referral: {
  queryParams: ['via', 'from', 'source'],
  // No path patterns needed, just query params
}
```

### Product Hunt / Launch Platforms
```typescript
referral: {
  queryParams: ['ref', 'via'],
  pathPatterns: ['/launch/([^/]+)']  // /launch/PRODUCT_HUNT
}
```

## Important Notes

- **First-touch attribution**: The first referral code captured in a session is preserved
- **Priority Order**: Query parameters are checked BEFORE path patterns
  - If a query param is found, path patterns are not checked
  - Both can be configured simultaneously and work as fallbacks
- **Case-sensitive**: Regex patterns are case-sensitive by default
- **Storage**: Referral codes are stored in session storage and persist across page navigations
- **SPA Support**: Referral codes are re-evaluated on URL changes (SPA navigation)
- **Multiple matches**: Only the first match is captured (query params → path patterns → first pattern match)

## Regex Pattern Tips

- `[^/]+` - Matches any character except `/` (most common)
- `[A-Z0-9]+` - Only uppercase letters and numbers
- `[a-z0-9-]+` - Lowercase letters, numbers, and hyphens
- `([^/]+)` - Parentheses create a capture group (required!)
- `{6}` - Exactly 6 characters
- `+` - One or more characters
- `*` - Zero or more characters

## Test Each Configuration

Create a simple test file to verify your patterns:

```typescript
const testReferralPatterns = (patterns: string[], testPaths: string[]) => {
  testPaths.forEach(path => {
    patterns.forEach(pattern => {
      const regex = new RegExp(pattern);
      const match = path.match(regex);
      if (match) {
        console.log(`✓ Pattern "${pattern}" matched "${path}" → Code: "${match[1]}"`);
      }
    });
  });
};

// Test your patterns
testReferralPatterns(
  ['/r/([^/]+)', '/invite/([^/]+)'],
  ['/r/ABC123', '/invite/XYZ789', '/about']
);
```

