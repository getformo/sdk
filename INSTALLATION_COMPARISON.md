# Formo SDK Installation Methods Comparison

This guide compares different ways to install and use the Formo Analytics SDK to help you choose the best method for your use case.

## Quick Comparison Table

| Method | Complexity | Control | Performance | Use Case |
|--------|-----------|---------|-------------|----------|
| **CDN (Formo Hosted)** | ⭐ Very Easy | Low | Fast (Global CDN) | Quick setup, prototyping |
| **CDN (unpkg.com)** | ⭐ Very Easy | Low | Fast (Global CDN) | Alternative CDN option |
| **Self-Hosted (UMD)** | ⭐⭐ Easy | High | Fast (Your infra) | Full control, compliance |
| **npm Package** | ⭐⭐⭐ Moderate | High | Optimal (Bundled) | Modern build pipeline |
| **Build from Source** | ⭐⭐⭐⭐ Advanced | Full | Optimal (Custom) | Custom builds, forks |

---

## 1. CDN Installation (Formo Hosted)

### Overview
Load the SDK directly from Formo's official CDN.

### Installation

```html
<script src="https://cdn.formo.so/analytics@latest"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### Pros ✅
- **Fastest setup** - Copy, paste, done
- **Always up-to-date** - Automatic updates with `@latest`
- **Cached globally** - Fast delivery worldwide
- **Zero maintenance** - Formo handles hosting and updates
- **Version pinning available** - Use `@1.20.0` instead of `@latest`

### Cons ❌
- **External dependency** - Relies on Formo's CDN uptime
- **Limited control** - Can't customize the build
- **Privacy considerations** - Script loads from third-party domain
- **Blocked by ad blockers** - Some users may have issues

### Best For
- Quick prototypes and MVPs
- Teams without infrastructure for self-hosting
- Projects where rapid iteration is priority
- Non-sensitive applications

### Example with Version Pinning

```html
<!-- Pin to specific version for stability -->
<script src="https://cdn.formo.so/analytics@1.20.0"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

---

## 2. CDN Installation (unpkg.com)

### Overview
Load the SDK from unpkg.com, which automatically serves npm packages.

### Installation

```html
<script src="https://unpkg.com/@formo/analytics@latest/dist/index.umd.min.js"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### Pros ✅
- All benefits of CDN delivery
- Alternative if Formo CDN is blocked
- Automatically syncs with npm releases
- Industry-standard CDN (used by many projects)

### Cons ❌
- Same limitations as Formo CDN
- Longer URL to maintain

### Best For
- Same as Formo CDN
- Projects that prefer established CDN providers
- Backup option if primary CDN is unavailable

---

## 3. Self-Hosted Installation (UMD Bundle)

### Overview
Download and host the pre-built SDK on your own infrastructure.

### Installation

```bash
# Download the SDK
curl -o public/formo-analytics.js \
  https://unpkg.com/@formo/analytics@1.20.0/dist/index.umd.min.js

# Generate SRI hash for security
cat public/formo-analytics.js | openssl dgst -sha384 -binary | openssl base64 -A
```

```html
<script 
  src="/formo-analytics.js"
  integrity="sha384-YOUR_HASH_HERE"
  crossorigin="anonymous"
></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### Pros ✅
- **Full control** - Host on your own infrastructure
- **No external dependencies** - Serves from your domain
- **Privacy compliant** - No third-party script loading
- **Custom caching** - Control cache policies
- **Offline capable** - Works in air-gapped environments
- **SRI support** - Enhanced security with integrity checks

### Cons ❌
- **Manual updates** - Need to update SDK versions yourself
- **More setup** - Requires hosting infrastructure
- **Your bandwidth** - SDK loads consume your resources

### Best For
- **Production applications** requiring full control
- **Regulated industries** (healthcare, finance, government)
- **Privacy-focused** applications
- **High-traffic sites** with existing CDN
- **Compliance requirements** (HIPAA, GDPR, SOC2)

### Automation

Use the provided script for easy updates:

```bash
./scripts/update-formo-sdk.sh 1.20.0
```

See [SELF_HOSTING.md](SELF_HOSTING.md) for detailed instructions.

---

## 4. npm Package Installation

### Overview
Install as a dependency and bundle with your application code.

### Installation

```bash
npm install @formo/analytics
# or
yarn add @formo/analytics
```

```javascript
import { formofy } from '@formo/analytics';

formofy("YOUR_API_KEY", {
  debug: process.env.NODE_ENV === 'development',
});
```

### Pros ✅
- **Bundled with your app** - Single bundle, optimal loading
- **TypeScript support** - Full type definitions included
- **Tree shaking** - Only bundle what you use
- **Version locked** - Controlled via package.json
- **Build optimization** - Minified with your code
- **No separate request** - SDK loads with your app bundle

### Cons ❌
- **Larger bundle size** - SDK added to your app bundle
- **Build step required** - Need webpack/vite/etc
- **No lazy loading** - SDK loaded even if not needed immediately

### Best For
- **React applications**
- **Vue, Angular, Svelte apps**
- **Next.js, Nuxt, SvelteKit**
- **TypeScript projects**
- **Modern SPAs with build pipelines**

### Framework Examples

#### React

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

#### Next.js (App Router)

```jsx
// app/layout.tsx
import { formofy } from '@formo/analytics';

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

#### Vue 3

```javascript
// main.js
import { createApp } from 'vue';
import { formofy } from '@formo/analytics';
import App from './App.vue';

const app = createApp(App);

formofy("YOUR_API_KEY");

app.mount('#app');
```

---

## 5. Build from Source

### Overview
Clone the repository and build a custom version of the SDK.

### Installation

```bash
# Clone the repository
git clone https://github.com/getformo/sdk.git
cd sdk

# Install dependencies
yarn install

# Build the SDK
yarn build

# Output: dist/index.umd.min.js
```

### Pros ✅
- **Full customization** - Modify source code as needed
- **Latest features** - Access unreleased features
- **Custom builds** - Remove unused features
- **Fork-friendly** - Create your own version
- **Debug builds** - Build with source maps

### Cons ❌
- **Most complex** - Requires development setup
- **Manual updates** - Need to sync with upstream
- **Build maintenance** - You maintain the build process

### Best For
- **Contributing to Formo SDK**
- **Custom feature development**
- **Research and experimentation**
- **Forked versions** with custom modifications

---

## Decision Tree

### Choose **CDN (Formo Hosted)** if:
- ✅ You want the fastest setup
- ✅ You're prototyping or testing
- ✅ You don't have hosting infrastructure
- ✅ Automatic updates are desired

### Choose **Self-Hosted (UMD)** if:
- ✅ You need full control over the SDK
- ✅ Privacy and compliance are critical
- ✅ You want to avoid external dependencies
- ✅ You have existing hosting infrastructure
- ✅ You're in a regulated industry

### Choose **npm Package** if:
- ✅ You're building a React/Vue/Angular app
- ✅ You use TypeScript
- ✅ You have a modern build pipeline
- ✅ You want optimal bundle optimization
- ✅ You prefer dependency management via npm/yarn

### Choose **Build from Source** if:
- ✅ You need to customize the SDK
- ✅ You're contributing features
- ✅ You're researching or experimenting
- ✅ You need features not yet released

---

## Migration Between Methods

### From CDN → Self-Hosted

```bash
# Download current version
curl -o public/formo-analytics.js https://cdn.formo.so/analytics@1.20.0

# Generate SRI
cat public/formo-analytics.js | openssl dgst -sha384 -binary | openssl base64 -A
```

Update HTML:
```html
<!-- Before -->
<script src="https://cdn.formo.so/analytics@1.20.0"></script>

<!-- After -->
<script 
  src="/formo-analytics.js"
  integrity="sha384-HASH"
  crossorigin="anonymous"
></script>
```

### From CDN → npm Package

```bash
npm install @formo/analytics
```

Replace script tag with import:
```javascript
import { formofy } from '@formo/analytics';
formofy("YOUR_API_KEY");
```

### From Self-Hosted → npm Package

Remove hosted file and install package:
```bash
npm install @formo/analytics
```

Update imports in your code.

---

## Performance Considerations

### Load Time Comparison

| Method | Initial Load | Cached Load | Total Requests |
|--------|-------------|-------------|----------------|
| CDN (Formo) | ~50ms | ~5ms | +1 |
| Self-Hosted | ~30ms | ~5ms | +0 (same domain) |
| npm Bundle | 0ms (bundled) | 0ms | +0 |

### Bundle Size Impact

- **UMD Bundle**: ~36 KB minified
- **npm (tree-shaken)**: ~30-36 KB
- **Gzipped**: ~12 KB

---

## Security Comparison

| Feature | CDN | Self-Hosted | npm Package |
|---------|-----|-------------|-------------|
| SRI Support | ✅ Yes | ✅ Yes | ⚠️ Bundled |
| CSP Compatible | ⚠️ External | ✅ Same-origin | ✅ Inline |
| Version Control | ⚠️ CDN-dependent | ✅ Full control | ✅ package.json |
| Supply Chain | ⚠️ Trust CDN | ✅ Verified file | ✅ npm registry |

---

## Recommended Setups

### Startups & MVPs
```html
<!-- CDN for speed -->
<script src="https://cdn.formo.so/analytics@latest"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

### Production Web Apps
```bash
# Self-hosted for control
./scripts/update-formo-sdk.sh 1.20.0
```

```html
<script 
  src="/libs/formo/1.20.0/analytics.min.js"
  integrity="sha384-HASH"
  crossorigin="anonymous"
></script>
```

### React/Next.js Apps
```bash
npm install @formo/analytics
```

```javascript
import { formofy } from '@formo/analytics';
formofy("YOUR_API_KEY");
```

### Enterprise/Regulated Industries
Self-hosted with versioning + SRI + CSP + monitoring

---

## Support

- 📖 [Documentation](https://docs.formo.so)
- 📦 [Self-Hosting Guide](SELF_HOSTING.md)
- 💬 [Community Slack](https://formo.so/slack)
- 🐛 [Report Issues](https://github.com/getformo/sdk/issues)

---

## Summary

**Quick Setup**: Use CDN  
**Production Control**: Self-host UMD  
**Modern Apps**: Use npm package  
**Custom Needs**: Build from source

Each method has trade-offs. Choose based on your priorities: speed of setup, control, privacy, or optimization.

