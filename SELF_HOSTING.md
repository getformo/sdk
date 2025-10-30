# Self-Hosting Support for Formo Analytics SDK

The Formo Analytics SDK supports self-hosting, allowing you to host the SDK on your own infrastructure instead of loading from `cdn.formo.so`.

## Inline Snippet Installation

Generate a complete inline snippet with the entire SDK embedded:

```bash
./scripts/generate-inline-script.sh 1.20.0 --inline
# Creates dist/inline-snippet-1.20.0.html - copy entire contents
```

Paste the entire snippet into your HTML `<head>` - no external files needed.

## Example HTML Scripts

After generating the inline snippet, you'll get a file that looks like this:

```html
<!-- 
  Formo Analytics SDK v1.20.0 - Inline Installation
  
  This is a self-contained, inline version of the Formo Analytics SDK.
  No external dependencies required - everything is included in this snippet.
  
  Generated: 2025-10-26T15:12:09.383Z
  Version: 1.20.0
  Size: 135 KB
  Integrity: sha384-Gf5TiX659wjVQuxu1GjfqZJusZCYZwAZjbjXMdz80wK/aCAx2Pyi/OYHGwO+KkgV
  
  Usage:
  1. Copy this entire snippet
  2. Paste into your HTML <head> section
  3. Replace <YOUR_WRITE_KEY> with your actual Formo API key
  
  Documentation: https://docs.formo.so
  GitHub: https://github.com/getformo/sdk
-->
<script defer>
  // --- Begin Formo SDK ---
  // Paste contents of formo.js here
  // --- End Formo SDK ---

  window.addEventListener('load', function () {
    window.formofy('<YOUR_WRITE_KEY>', {
      ready: function (formo) {
        formo.identify();
      },
    });
  });
</script>
```

### Basic Usage

```html
<script defer>
  // --- Begin Formo SDK ---
  /* SDK code embedded */
  // --- End Formo SDK ---

  window.addEventListener('load', function () {
    window.formofy('<YOUR_WRITE_KEY>', {
      ready: function (formo) {
        formo.identify();
      },
    });
  });
</script>
```

## Versioning

The script generates versioned files. To update to a new version:

```bash
# Generate snippet for specific version
./scripts/generate-inline-script.sh 1.21.0 --inline

# Generate snippet for latest version
./scripts/generate-inline-script.sh latest --inline
```

Then copy the new snippet and replace the old one in your HTML.

## Security Best Practices

1. **Pin to specific versions** - avoid using "latest" in production
2. **Serve over HTTPS** - always use HTTPS for security
3. **Update Content Security Policy** if needed:
   ```
   Content-Security-Policy: script-src 'self' 'unsafe-inline';
   ```

## Automation Script

The `generate-inline-script.sh` script downloads the SDK from the CDN and generates a complete inline snippet file.

**Usage:**
```bash
./scripts/generate-inline-script.sh [version] --inline
```

**Examples:**
```bash
# Generate for specific version
./scripts/generate-inline-script.sh 1.20.0 --inline

# Generate for latest version
./scripts/generate-inline-script.sh latest --inline
```

The generated file will be saved to `dist/inline-snippet-{version}.html`. Open this file, copy the entire contents, and paste it into your HTML `<head>` section.
