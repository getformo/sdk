# Quick Start: Self-Hosting Formo SDK

Choose your approach and follow the steps below. For detailed information, see [SELF_HOSTING.md](SELF_HOSTING.md).

---

## 🚀 Option 1: Download & Host (Recommended)

**Best for:** Production websites, full control, compliance requirements

### Steps:

```bash
# 1. Download the SDK
./scripts/update-formo-sdk.sh 1.20.0

# 2. Copy the snippet from the output

# 3. Paste into your HTML <head>
```

**Result:**
```html
<script 
  src="/libs/formo/1.20.0/analytics.min.js"
  integrity="sha384-[AUTO_GENERATED_HASH]"
  crossorigin="anonymous"
></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

**Time:** 2 minutes  
**Maintenance:** Manual version updates  
**Control:** High

---

## 📋 Option 2: Inline Snippet (Safary-style)

**Best for:** Maximum simplicity, zero external files, complete isolation

### Steps:

```bash
# 1. Generate inline snippet
node scripts/generate-inline-snippet.js 1.20.0

# 2. Open the generated file
open dist/inline-snippet-1.20.0.html

# 3. Copy entire contents and paste into your HTML <head>
```

**Result:**
```html
<script>
  /* Entire SDK code (135 KB) embedded here */
</script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

**Time:** 3 minutes  
**Maintenance:** Copy-paste new snippet for updates  
**Control:** Maximum

---

## 📦 Option 3: npm Package

**Best for:** React, Vue, Next.js, modern SPAs with build tools

### Steps:

```bash
# 1. Install via npm
npm install @formo/analytics
```

```javascript
// 2. Import and initialize in your app
import { formofy } from '@formo/analytics';

formofy("YOUR_API_KEY");
```

**Time:** 1 minute  
**Maintenance:** Standard npm updates  
**Control:** High (part of your bundle)

---

## 🌐 Option 4: CDN (Fastest Setup)

**Best for:** Prototypes, MVPs, testing

### Steps:

```html
<!-- Just paste this into your HTML <head> -->
<script src="https://cdn.formo.so/analytics@1.20.0"></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
```

**Time:** 30 seconds  
**Maintenance:** Change version number  
**Control:** Low (external CDN)

---

## 🔧 Option 5: Build from Source

**Best for:** Custom modifications, contributions

### Steps:

```bash
# 1. Clone the repository
git clone https://github.com/getformo/sdk.git
cd sdk

# 2. Install dependencies
yarn install

# 3. Build the SDK
yarn build

# 4. Use dist/index.umd.min.js
```

**Time:** 5 minutes  
**Maintenance:** Git pulls and rebuilds  
**Control:** Complete

---

## 📊 Quick Comparison

| Method | Setup Time | Control | Updates | Best For |
|--------|-----------|---------|---------|----------|
| **Download & Host** | 2 min | High | Manual | Production |
| **Inline Snippet** | 3 min | Maximum | Copy-paste | Simplicity |
| **npm Package** | 1 min | High | npm update | React/Vue |
| **CDN** | 30 sec | Low | Change URL | Prototypes |
| **Build from Source** | 5 min | Complete | Git pull | Custom mods |

---

## 🔒 Security Checklist

For production deployments:

- ✅ Use specific version (not "latest")
- ✅ Include SRI hash (`integrity="sha384-..."`)
- ✅ Serve over HTTPS
- ✅ Set appropriate cache headers
- ✅ Update Content Security Policy if needed
- ✅ Test in staging before production

---

## 📖 Need More Details?

- **Complete Guide:** [SELF_HOSTING.md](SELF_HOSTING.md)
- **Compare All Methods:** [INSTALLATION_COMPARISON.md](INSTALLATION_COMPARISON.md)
- **Copy-Paste Snippet:** [SNIPPET.html](SNIPPET.html)
- **Implementation Summary:** [SELF_HOSTING_SUMMARY.md](SELF_HOSTING_SUMMARY.md)

---

## 🆘 Quick Troubleshooting

### SDK not loading?
```javascript
// Check in browser console:
console.log(typeof window.formofy); // Should output "function"
```

### Need debug info?
```javascript
window.formofy("YOUR_API_KEY", { debug: true });
```

### Generate SRI hash?
```bash
./scripts/generate-sri-hash.sh path/to/file.js
```

### Check SDK version?
```javascript
// In browser console:
console.log(window.FormoAnalytics?.version);
```

---

## 🎯 Recommended Setup

### For Production Websites:
```bash
./scripts/update-formo-sdk.sh 1.20.0
```
Then use the generated snippet with SRI hash.

### For React/Next.js:
```bash
npm install @formo/analytics
```
Import and use in your components.

### For Maximum Simplicity:
```bash
node scripts/generate-inline-snippet.js 1.20.0
```
Copy the entire generated snippet.

---

## 📞 Support

- 💬 [Community Slack](https://formo.so/slack)
- 📖 [Documentation](https://docs.formo.so)
- 🐛 [GitHub Issues](https://github.com/getformo/sdk/issues)

---

**Quick Start complete!** Choose an option above and you'll be up and running in minutes.

