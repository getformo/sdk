# Self-Hosting Guide for Formo Analytics SDK

This guide explains how to self-host the Formo Analytics SDK instead of loading it from the Formo CDN (`cdn.formo.so`).

## Why Self-Host?

- **Full control**: Host the SDK on your own infrastructure
- **Privacy**: No external dependencies for script delivery
- **Compliance**: Meet regulatory requirements for data sovereignty
- **Performance**: Serve from the same domain to avoid CORS and reduce latency
- **Reliability**: Independence from third-party CDN uptime

## Quick Start

### Option 1: Download Pre-built Bundle (Recommended)

The easiest way to self-host is to download the pre-built UMD bundle from npm or the Formo CDN.

#### From npm Package

```bash
# Install the package
npm install @formo/analytics

# Copy the UMD bundle to your public directory
cp node_modules/@formo/analytics/dist/index.umd.min.js public/formo-analytics.js
```

#### From Formo CDN

```bash
# Download a specific version
curl -o formo-analytics.js https://cdn.formo.so/analytics@1.20.0

# Or download the latest version
curl -o formo-analytics.js https://cdn.formo.so/analytics@latest
```

### Option 2: Build from Source

If you want to customize the build or build from a specific commit:

```bash
# Clone the repository
git clone https://github.com/getformo/sdk.git
cd sdk

# Install dependencies
yarn install

# Build the SDK
yarn build

# The UMD bundle will be at: dist/index.umd.min.js
```

## Installation Methods

### 1. Standard HTML Script Tag

After hosting the file, include it in your HTML:

```html
<!-- Basic usage -->
<script src="/path/to/formo-analytics.js"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### 2. With Subresource Integrity (SRI)

For enhanced security, use SRI to verify the file hasn't been tampered with:

```html
<script 
  src="/path/to/formo-analytics.js"
  integrity="sha384-YOUR_HASH_HERE"
  crossorigin="anonymous"
></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

Generate the SRI hash:

```bash
# Using openssl
cat formo-analytics.js | openssl dgst -sha384 -binary | openssl base64 -A

# Using the provided script
./scripts/generate-sri-hash.sh formo-analytics.js
```

### 3. Module Bundler (Webpack, Vite, etc.)

If you're using a bundler, you can import the SDK directly:

```bash
npm install @formo/analytics
```

```javascript
import { formofy } from '@formo/analytics';

formofy("YOUR_API_KEY");
```

This will bundle the SDK with your application code.

## Versioning Strategies

### Strategy 1: Version in Filename (Recommended)

Store different versions with version numbers in the filename:

```
/public/js/
  formo-analytics-1.20.0.js
  formo-analytics-1.21.0.js
  formo-analytics-latest.js  (symlink or copy of latest)
```

**Usage:**
```html
<!-- Pin to specific version -->
<script src="/js/formo-analytics-1.20.0.js"></script>

<!-- Always use latest (updates require file replacement) -->
<script src="/js/formo-analytics-latest.js"></script>
```

**Pros:**
- Simple to implement
- Clear version tracking
- Easy rollback
- Immutable versioned files

**Cons:**
- Requires HTML updates for version changes
- More files to manage

### Strategy 2: Directory-Based Versioning

Organize by directories:

```
/public/libs/formo/
  1.20.0/
    analytics.js
  1.21.0/
    analytics.js
  latest/
    analytics.js
```

**Usage:**
```html
<script src="/libs/formo/1.20.0/analytics.js"></script>
```

**Pros:**
- Clean organization
- Easy to add additional assets per version
- Clear version separation

**Cons:**
- More complex directory structure

### Strategy 3: Query Parameter Versioning

Single endpoint with version as query parameter:

```
/formo-analytics.js?v=1.20.0
```

Requires server-side logic to serve different versions based on the query parameter.

**Pros:**
- Single URL pattern
- Easy to update via query parameter

**Cons:**
- Requires server-side routing
- More complex cache management

### Strategy 4: Header-Based Versioning

Use immutable URLs with aggressive caching, update the filename hash on each release:

```
/js/formo-analytics.[contenthash].js
```

**Pros:**
- Optimal caching
- Automatic cache busting
- Used by most modern build tools

**Cons:**
- Requires build tooling
- HTML must be updated on each release

## Recommended Setup

Here's our recommended production setup:

```
/public/libs/formo/
  1.20.0/
    analytics.min.js
    analytics.min.js.map
  latest/
    analytics.min.js
    analytics.min.js.map
```

**In your HTML:**
```html
<!-- For production: pin to specific version -->
<script 
  src="/libs/formo/1.20.0/analytics.min.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>

<!-- For development/testing: use latest -->
<script src="/libs/formo/latest/analytics.min.js"></script>

<script>
  window.formofy("YOUR_API_KEY", {
    debug: false, // Enable in development
  });
</script>
```

## Automation Scripts

### Update Script

Create a script to download and update to the latest version:

```bash
#!/bin/bash
# scripts/update-formo-sdk.sh

VERSION=${1:-latest}
DEST_DIR="public/libs/formo"
DEST_FILE="$DEST_DIR/$VERSION/analytics.min.js"

echo "Downloading Formo Analytics SDK version: $VERSION"

# Create directory
mkdir -p "$DEST_DIR/$VERSION"

# Download from npm CDN (unpkg)
curl -L "https://unpkg.com/@formo/analytics@$VERSION/dist/index.umd.min.js" \
  -o "$DEST_FILE"

# Download source map if available
curl -L "https://unpkg.com/@formo/analytics@$VERSION/dist/index.umd.min.js.map" \
  -o "$DEST_FILE.map" 2>/dev/null || true

# Generate SRI hash
HASH=$(cat "$DEST_FILE" | openssl dgst -sha384 -binary | openssl base64 -A)

echo ""
echo "✅ Downloaded to: $DEST_FILE"
echo ""
echo "📋 Use this in your HTML:"
echo ""
echo "<script"
echo "  src=\"/libs/formo/$VERSION/analytics.min.js\""
echo "  integrity=\"sha384-$HASH\""
echo "  crossorigin=\"anonymous\""
echo "></script>"
```

Make it executable:
```bash
chmod +x scripts/update-formo-sdk.sh
```

Use it:
```bash
# Download specific version
./scripts/update-formo-sdk.sh 1.20.0

# Download latest
./scripts/update-formo-sdk.sh latest
```

## Security Considerations

### 1. Subresource Integrity (SRI)

Always use SRI hashes in production:

```html
<script 
  src="/libs/formo/1.20.0/analytics.min.js"
  integrity="sha384-[HASH]"
  crossorigin="anonymous"
></script>
```

### 2. Content Security Policy (CSP)

Update your CSP headers to allow your self-hosted script:

```
Content-Security-Policy: script-src 'self' 'unsafe-inline';
```

Or better, with a hash:

```
Content-Security-Policy: script-src 'self' 'sha256-[HASH]';
```

### 3. Immutable Caching

For versioned files, use aggressive caching:

```nginx
# nginx example
location ~* /libs/formo/\d+\.\d+\.\d+/ {
    add_header Cache-Control "public, immutable, max-age=31536000";
}
```

### 4. HTTPS Only

Always serve the SDK over HTTPS to prevent man-in-the-middle attacks.

## Testing

After setting up self-hosting, verify it works:

```javascript
// Open browser console
console.log(typeof window.formofy); // Should output "function"
console.log(typeof window.FormoAnalytics); // Should output "object"
```

Enable debug mode to see tracking events:

```javascript
window.formofy("YOUR_API_KEY", { debug: true });
```

## Migration from CDN

### Before (CDN):
```html
<script src="https://cdn.formo.so/analytics@latest"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### After (Self-Hosted):
```html
<script src="/libs/formo/1.20.0/analytics.min.js"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### Gradual Rollout

Test self-hosted version alongside CDN:

```html
<script>
  // Feature flag or A/B test
  const useSelfHosted = Math.random() < 0.5;
  const scriptSrc = useSelfHosted 
    ? '/libs/formo/1.20.0/analytics.min.js'
    : 'https://cdn.formo.so/analytics@1.20.0';
    
  const script = document.createElement('script');
  script.src = scriptSrc;
  script.onload = () => window.formofy("YOUR_API_KEY");
  document.head.appendChild(script);
</script>
```

## Updating to New Versions

### Manual Updates

1. Download the new version
2. Update the SRI hash
3. Update your HTML
4. Deploy changes
5. Clear CDN cache (if applicable)

### Automated Updates

Use the update script in your CI/CD pipeline:

```yaml
# .github/workflows/update-formo-sdk.yml
name: Update Formo SDK

on:
  schedule:
    - cron: '0 0 * * 1' # Weekly on Monday
  workflow_dispatch: # Manual trigger

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Update SDK
        run: ./scripts/update-formo-sdk.sh latest
      - name: Create PR
        uses: peter-evans/create-pull-request@v5
        with:
          commit-message: 'chore: update Formo SDK'
          title: 'Update Formo Analytics SDK'
          body: 'Automated update of Formo Analytics SDK to latest version'
```

## Troubleshooting

### Script Not Loading

- Check browser console for errors
- Verify the file path is correct
- Check file permissions
- Verify MIME type is `application/javascript`

### CORS Errors

- Ensure you're serving from the same origin, or
- Add appropriate CORS headers to your server

### CSP Violations

- Update Content-Security-Policy headers
- Use SRI hashes
- Avoid `unsafe-inline` if possible

### Script Loaded but Not Working

- Check that `window.formofy` is defined
- Enable debug mode: `window.formofy("KEY", { debug: true })`
- Check network tab for API calls to Formo

## Performance Optimization

### 1. Use HTTP/2 Server Push

```nginx
location = /index.html {
    http2_push /libs/formo/1.20.0/analytics.min.js;
}
```

### 2. Preload

```html
<link rel="preload" href="/libs/formo/1.20.0/analytics.min.js" as="script">
```

### 3. Async Loading

```html
<script src="/libs/formo/1.20.0/analytics.min.js" async></script>
```

### 4. Compression

Ensure your server sends compressed responses:

```nginx
gzip on;
gzip_types application/javascript;
```

## Support

For questions or issues:
- 📖 [Formo Documentation](https://docs.formo.so)
- 💬 [Community Slack](https://formo.so/slack)
- 🐛 [GitHub Issues](https://github.com/getformo/sdk/issues)

## License

The Formo Analytics SDK is open source under the MIT License. See [LICENSE](LICENSE) for details.

