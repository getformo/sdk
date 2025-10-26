# Self-Hosting Support - Implementation Summary

This document summarizes the self-hosting support added to the Formo Analytics SDK.

## Overview

The Formo SDK now provides comprehensive self-hosting support, allowing builders to compile and host the SDK themselves instead of loading from `cdn.formo.so`. This gives teams full control over their analytics infrastructure while maintaining the open-source nature of the SDK.

## Questions Answered

### Q: Can we just paste https://cdn.formo.so/analytics@latest?

**Yes!** The URL serves the pre-built UMD bundle (`dist/index.umd.min.js`), which is a self-contained JavaScript file that can be:

1. **Downloaded and hosted**: Simply copy the file to your server
2. **Inlined in HTML**: Paste the entire contents in a `<script>` tag (see SNIPPET.html)
3. **Versioned**: Pin to specific versions or use "latest"

The SDK is already designed for this purpose - no modifications needed.

### Q: How to do versioning?

We provide **four recommended versioning strategies**:

1. **Version in Filename** (Recommended)
   ```
   /js/formo-analytics-1.20.0.js
   /js/formo-analytics-1.21.0.js
   /js/formo-analytics-latest.js
   ```

2. **Directory-Based**
   ```
   /libs/formo/1.20.0/analytics.js
   /libs/formo/1.21.0/analytics.js
   /libs/formo/latest/analytics.js
   ```

3. **Query Parameter** (requires server-side routing)
   ```
   /formo-analytics.js?v=1.20.0
   ```

4. **Content Hash** (for build tools)
   ```
   /js/formo-analytics.[contenthash].js
   ```

See [SELF_HOSTING.md](SELF_HOSTING.md) for detailed pros/cons of each approach.

## What Was Added

### 1. Documentation

#### [SELF_HOSTING.md](SELF_HOSTING.md) - Complete Self-Hosting Guide
- Quick start instructions
- Multiple installation methods
- Detailed versioning strategies
- Security best practices (SRI, CSP)
- Automation scripts
- Migration guides
- Performance optimization
- Troubleshooting

#### [INSTALLATION_COMPARISON.md](INSTALLATION_COMPARISON.md) - Installation Methods Comparison
- Side-by-side comparison of all installation methods
- Decision tree for choosing the right method
- Performance benchmarks
- Security comparison
- Framework-specific examples
- Migration paths between methods

#### [SNIPPET.html](SNIPPET.html) - Copy-Paste Snippet
- Ready-to-use HTML snippet
- Multiple configuration examples
- Quick start guide embedded in comments
- Similar to Safary's approach

#### [README.md](README.md) - Updated
- Added self-hosting section with links to detailed guides

### 2. Automation Scripts

#### `scripts/update-formo-sdk.sh` - SDK Update Script
Downloads the latest (or specific) version of the SDK from npm CDN and generates SRI hash.

**Usage:**
```bash
./scripts/update-formo-sdk.sh 1.20.0  # Specific version
./scripts/update-formo-sdk.sh latest  # Latest version
```

**Features:**
- Downloads SDK from unpkg.com
- Downloads source map
- Generates SHA-384 SRI hash
- Creates README in version directory
- Provides ready-to-use HTML snippet

#### `scripts/generate-sri-hash.sh` - SRI Hash Generator
Generates Subresource Integrity hashes for any file.

**Usage:**
```bash
./scripts/generate-sri-hash.sh public/formo-analytics.js
```

**Features:**
- Generates SHA-256, SHA-384, and SHA-512 hashes
- Provides ready-to-use HTML snippet
- Works with any file

#### `scripts/generate-inline-snippet.js` - Inline Snippet Generator
Creates a complete inline snippet with the SDK embedded (Safary-style approach).

**Usage:**
```bash
node scripts/generate-inline-snippet.js 1.20.0
node scripts/generate-inline-snippet.js latest
```

**Features:**
- Fetches SDK from npm CDN
- Embeds entire SDK in HTML snippet
- Zero external dependencies
- Calculates integrity hash
- Saves to `dist/inline-snippet-{version}.html`

### 3. CI/CD Example

#### `.github/workflows/update-sdk-example.yml.example` - Automation Workflow
Example GitHub Actions workflow for automating SDK updates.

**Features:**
- Weekly scheduled updates
- Manual trigger with version input
- Automatic PR creation
- Includes testing checklist

**Usage:**
Copy to your project and remove `.example` extension.

## Installation Methods Supported

### 1. CDN (Formo Hosted)
```html
<script src="https://cdn.formo.so/analytics@1.20.0"></script>
<script>window.formofy("YOUR_API_KEY");</script>
```

**Best for:** Quick setup, prototyping

### 2. Self-Hosted (Download)
```bash
curl -o public/formo.js https://unpkg.com/@formo/analytics@1.20.0/dist/index.umd.min.js
```

```html
<script src="/formo.js" integrity="sha384-..." crossorigin="anonymous"></script>
<script>window.formofy("YOUR_API_KEY");</script>
```

**Best for:** Production, compliance, full control

### 3. Self-Hosted (Inline)
```html
<script>
  /* Entire SDK code pasted here */
</script>
<script>window.formofy("YOUR_API_KEY");</script>
```

**Best for:** Maximum control, zero external dependencies

### 4. npm Package
```bash
npm install @formo/analytics
```

```javascript
import { formofy } from '@formo/analytics';
formofy("YOUR_API_KEY");
```

**Best for:** React, Vue, Next.js, modern SPAs

### 5. Build from Source
```bash
git clone https://github.com/getformo/sdk.git
yarn install && yarn build
```

**Best for:** Customization, contributions

## Quick Start Examples

### For HTML Websites
```bash
# Download SDK
./scripts/update-formo-sdk.sh 1.20.0

# Copy snippet from output, paste into HTML
```

### For React Apps
```bash
npm install @formo/analytics
```

```jsx
import { formofy } from '@formo/analytics';
useEffect(() => formofy("YOUR_API_KEY"), []);
```

### For Maximum Simplicity (Safary-style)
```bash
# Generate inline snippet
node scripts/generate-inline-snippet.js 1.20.0

# Open dist/inline-snippet-1.20.0.html
# Copy entire contents
# Paste into your HTML <head>
```

## Security Features

### Subresource Integrity (SRI)
All scripts generate SRI hashes automatically:
```html
<script 
  src="/formo.js"
  integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
  crossorigin="anonymous"
></script>
```

### Content Security Policy (CSP)
Examples provided for:
- Self-hosted scripts
- Inline scripts with hashes
- External CDN scripts

### HTTPS Only
Documentation emphasizes HTTPS for all deployments.

## Performance Optimizations

Documentation includes:
- HTTP/2 Server Push examples
- Preload strategies
- Async loading patterns
- Compression configuration
- Immutable caching for versioned files

## Comparison to Safary

**Safary's Approach:**
- Provides a single inline snippet
- All code embedded in HTML
- Simple copy-paste

**Formo's Approach:**
- **Multiple options**: Inline, hosted, npm, CDN
- **Automation**: Scripts for updates and hash generation
- **Documentation**: Comprehensive guides for each method
- **CI/CD**: Example workflows for automation
- **Flexibility**: Choose the method that fits your needs

Formo provides the Safary-style inline approach PLUS additional options for teams with different requirements.

## Files Added/Modified

### New Files
- `SELF_HOSTING.md` - Complete self-hosting guide
- `INSTALLATION_COMPARISON.md` - Installation methods comparison
- `SNIPPET.html` - Ready-to-use HTML snippet
- `SELF_HOSTING_SUMMARY.md` - This file
- `scripts/update-formo-sdk.sh` - SDK update automation
- `scripts/generate-sri-hash.sh` - SRI hash generator
- `scripts/generate-inline-snippet.js` - Inline snippet generator
- `.github/workflows/update-sdk-example.yml.example` - CI/CD example

### Modified Files
- `README.md` - Added self-hosting section

### Existing Files (Unchanged)
- `dist/index.umd.min.js` - Pre-built UMD bundle (already suitable for self-hosting)
- `package.json` - Already configured with `unpkg` field
- `webpack.config.ts` - Already builds UMD bundle
- `scripts/generate-sri.sh` - Existing SRI script for CDN releases

## Next Steps

### For SDK Maintainers
1. ✅ Review documentation for accuracy
2. ✅ Test automation scripts
3. Consider adding to official documentation site
4. Consider adding self-hosting examples to GitHub releases

### For SDK Users
1. Read [SELF_HOSTING.md](SELF_HOSTING.md) for detailed instructions
2. Choose installation method from [INSTALLATION_COMPARISON.md](INSTALLATION_COMPARISON.md)
3. Use provided scripts for automation
4. Follow security best practices (SRI, CSP, HTTPS)

## Benefits

### For Users
- **Full control** over SDK hosting
- **Privacy compliance** (GDPR, HIPAA, etc.)
- **No external dependencies** for script delivery
- **Version locking** for stability
- **Custom caching** policies
- **Offline capability** (air-gapped environments)

### For Formo
- **Open source commitment** demonstrated
- **Enterprise-friendly** approach
- **Flexibility** for all use cases
- **Competitive advantage** over closed platforms
- **Community trust** through transparency

## Support

- 📖 [Self-Hosting Guide](SELF_HOSTING.md)
- 📊 [Installation Comparison](INSTALLATION_COMPARISON.md)
- 📋 [Quick Snippet](SNIPPET.html)
- 💬 [Community Slack](https://formo.so/slack)
- 🐛 [GitHub Issues](https://github.com/getformo/sdk/issues)

## License

All added documentation and scripts are under the same MIT License as the Formo SDK.

---

**Summary**: The Formo SDK now provides comprehensive self-hosting support with multiple installation methods, automation scripts, detailed documentation, and security best practices. Users can choose from CDN, self-hosted, inline, npm package, or build-from-source approaches based on their needs.

