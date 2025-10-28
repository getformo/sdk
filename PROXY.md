# Proxy Support for Formo SDK

## Overview

The Formo SDK supports using proxy URLs to bypass ad blockers by sending analytics events through your own domain instead of directly to `events.formo.so`. This enables data collection even when users have privacy browsers or ad blockers enabled.

## How It Works

When an `apiHost` is configured in the SDK options, all events are sent to your custom endpoint instead of directly to Formo. Your server then forwards these requests to Formo's API endpoint with the necessary authentication headers.

**Without Custom Host (Blocked by Ad Blockers):**
```
Browser → events.formo.so ❌ (blocked)
```

**With Custom Host (Works):**
```
Browser → your-host-url.com/ingest ✅ → events.formo.so ✅
```

## Configuration

### Basic Usage

Add the `apiHost` option to your Formo configuration:

```javascript
import { formofy } from '@formo/analytics';

formofy('your-write-key', {
  apiHost: 'https://your-host-url.com/ingest',  // Custom API host
  // or
  // apiHost: '/api/analytics',  // Relative URL
});
```

### React Provider

```tsx
import { FormoAnalyticsProvider } from '@formo/analytics';

function App() {
  return (
    <FormoAnalyticsProvider
      writeKey="your-write-key"
      options={{
        apiHost: 'https://your-host-url.com/ingest',
      }}
    >
      {/* Your app */}
    </FormoAnalyticsProvider>
  );
}
```

## Proxy Server Examples

### Next.js API Route

Create `pages/api/analytics.ts` or `app/api/analytics/route.ts`:

#### App Router (Next.js 13+)

```typescript
// app/api/analytics/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Forward the request to Formo
    const response = await fetch('https://events.formo.so/v0/raw_events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': request.headers.get('Authorization') || '',
      },
      body: JSON.stringify(body),
    });

    const data = await response.text();
    
    return NextResponse.json(
      data,
      { status: response.status }
    );
  } catch (error) {
    console.error('Formo proxy error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

#### Pages Router (Next.js 12 and earlier)

```typescript
// pages/api/analytics.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('https://events.formo.so/v0/raw_events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization || '',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).json(JSON.parse(data));
  } catch (error) {
    console.error('Formo proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

### Cloudflare Workers

Create a Cloudflare Worker:

```typescript
// worker.ts
export default {
  async fetch(request: Request): Promise<Response> {
    // Only allow POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Get the request body
      const body = await request.text();
      
      // Forward to Formo API
      const response = await fetch('https://events.formo.so/v0/raw_events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': request.headers.get('Authorization') || '',
        },
        body: body,
      });

      const data = await response.text();
      
      return new Response(data, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error('Formo proxy error:', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
```

Deploy to Cloudflare Workers:
```bash
npm install -g wrangler
wrangler publish
```

### Vercel Serverless Function

Create `api/analytics.ts`:

```typescript
// api/analytics.ts
import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('https://events.formo.so/v0/raw_events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization || '',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).json(JSON.parse(data));
  } catch (error) {
    console.error('Formo proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

### Express.js / Node.js

```typescript
// server.ts
import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/analytics', async (req, res) => {
  try {
    const response = await fetch('https://events.formo.so/v0/raw_events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization || '',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).json(JSON.parse(data));
  } catch (error) {
    console.error('Formo proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(3000);
```

## Security Considerations

### Validate Write Key (Optional but Recommended)

For added security, you can validate the write key on your proxy before forwarding requests:

```typescript
// Example: Validate write key
const FORMO_WRITE_KEY = 'your-write-key'; // Store securely

app.post('/api/analytics', async (req, res) => {
  // Extract write key from Authorization header
  const authHeader = req.headers.authorization || '';
  const writeKey = authHeader.replace('Basic ', '');
  
  // Validate write key
  if (writeKey !== FORMO_WRITE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // ... rest of the proxy logic
});
```

### Rate Limiting

Consider implementing rate limiting to prevent abuse:

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});

app.post('/api/analytics', limiter, async (req, res) => {
  // ... proxy logic
});
```

## CORS Configuration

If you're using a separate domain for your proxy, you may need to configure CORS:

```typescript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
```

## Testing

Test your proxy endpoint with curl:

```bash
curl -X POST https://myapp.com/api/analytics \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic your-write-key" \
  -d '[{"type":"page","properties":{},"message_id":"test"}]'
```

## Troubleshooting

### Events Not Being Received

1. Check your proxy logs for errors
2. Verify the Authorization header is being forwarded correctly
3. Ensure the request body format matches Formo's expected format
4. Check browser console for network errors

### Ad Blockers Still Blocking

1. Ensure your proxy URL doesn't contain words like "analytics", "tracking", or "data" in common ad blocker lists
2. Consider using a generic endpoint name like `/api/events` or `/api/telemetry`
3. Use your own domain, not a subdomain

## References

- [Plausible Proxy Guide](https://plausible.io/docs/proxy/introduction)
- [PostHog Proxy Documentation](https://posthog.com/docs/advanced/proxy)
- [Simple Analytics Proxy](https://docs.simpleanalytics.com/bypass-ad-blockers)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [DataFam Proxy Example](https://datafa.st/docs/nextjs-proxy)
