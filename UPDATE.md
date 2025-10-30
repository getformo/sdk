# Self-Hosting Support for Formo Analytics SDK

The Formo Analytics SDK now supports self-hosting, allowing you to host the SDK on your own infrastructure instead of loading from `cdn.formo.so`.

## Quick Answers

**Q: Can we just paste `https://cdn.formo.so/analytics@latest`?**

Yes! You can download that file and host it yourself. The SDK is a self-contained UMD bundle that can be hosted anywhere.

**Q: How to do versioning?**

Use versioned filenames or directories. See examples below.

## Installation Methods

### Option 1: Download & Host (Recommended for Production)

```bash
# Download from npm CDN
curl -o formo-analytics.js https://unpkg.com/@formo/analytics@1.20.0/dist/index.umd.min.js

# Or use the automation script
./scripts/update-formo-sdk.sh 1.20.0
```

```html
<script 
  src="/formo-analytics.js"
  integrity="sha384-[GENERATE_HASH]"
  crossorigin="anonymous"
></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### Option 2: Inline Snippet (Safary-style)

Generate a complete inline snippet with the entire SDK embedded:

```bash
./scripts/update-formo-sdk.sh 1.20.0 --inline
# Creates dist/inline-snippet-1.20.0.html - copy entire contents
```

Paste the entire snippet into your HTML `<head>` - no external files needed.

### Option 3: npm Package

For React/Vue/Next.js apps:

```bash
npm install @formo/analytics
```

```javascript
import { formofy } from '@formo/analytics';
formofy("YOUR_API_KEY");
```

### Option 4: CDN (Fastest Setup)

```html
<script src="https://cdn.formo.so/analytics@1.20.0"></script>
<script>window.formofy("YOUR_API_KEY");</script>
```

## Versioning Strategies

### Strategy 1: Version in Filename (Recommended)
```
/js/formo-analytics-1.20.0.js
/js/formo-analytics-1.21.0.js
/js/formo-analytics-latest.js (symlink or copy)
```

### Strategy 2: Directory-Based
```
/libs/formo/1.20.0/analytics.js
/libs/formo/1.21.0/analytics.js
/libs/formo/latest/analytics.js
```

## Automation Scripts

One script handles both hosted files and inline snippets:

### `update-formo-sdk.sh`

**Download SDK for hosting:**
```bash
./scripts/update-formo-sdk.sh 1.20.0
# Downloads to public/libs/formo/1.20.0/analytics.min.js
```

**Generate inline snippet (Safary-style):**
```bash
./scripts/update-formo-sdk.sh 1.20.0 --inline
# Creates dist/inline-snippet-1.20.0.html with entire SDK embedded
```

**Note:** There's also `scripts/generate-sri.sh` used for releases - it fetches from CDN and updates GitHub release notes.

## Security Best Practices

1. **Use SRI hashes** for production deployments:
   ```bash
   cat formo-analytics.js | openssl dgst -sha384 -binary | openssl base64 -A
   ```

2. **Pin to specific versions** - avoid using "latest" in production

3. **Serve over HTTPS** - always use HTTPS for security

4. **Update CSP headers** if needed:
   ```
   Content-Security-Policy: script-src 'self' 'sha384-[HASH]';
   ```

## Examples

### React App
```jsx
import { formofy } from '@formo/analytics';
import { useEffect } from 'react';

function App() {
  useEffect(() => {
    formofy("YOUR_API_KEY");
  }, []);
  return <div>Your App</div>;
}
```

### Next.js App Router
```jsx
// app/layout.tsx
import { formofy } from '@formo/analytics';
import { useEffect } from 'react';

export default function RootLayout({ children }) {
  useEffect(() => {
    formofy("YOUR_API_KEY");
  }, []);
  
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
```

### Vue 3
```javascript
// main.js
import { createApp } from 'vue';
import { formofy } from '@formo/analytics';
import App from './App.vue';

const app = createApp(App);
formofy("YOUR_API_KEY");
app.mount('#app');
```

## Troubleshooting

**SDK not loading?**
```javascript
console.log(typeof window.formofy); // Should output "function"
```

**Enable debug mode:**
```javascript
window.formofy("YOUR_API_KEY", { debug: true });
```

**Generate SRI hash:**
```bash
cat formo-analytics.js | openssl dgst -sha384 -binary | openssl base64 -A
```

## Summary

- ✅ Download pre-built bundle from npm/CDN
- ✅ Host on your own infrastructure  
- ✅ Use provided scripts for automation
- ✅ Generate inline snippets (Safary-style)
- ✅ Full npm package support for modern apps
- ✅ Security features (SRI, HTTPS, CSP)

All files needed are in the `scripts/` directory. The SDK works exactly the same whether loaded from CDN or self-hosted.

