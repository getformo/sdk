#!/bin/bash
set -e

# Formo Analytics SDK - Self-Hosting Script
# Downloads SDK and generates either hosted file or inline snippet
# Usage: ./scripts/update-formo-sdk.sh [version] [--inline]
# Examples:
#   ./scripts/update-formo-sdk.sh 1.20.0           # Download for hosting
#   ./scripts/update-formo-sdk.sh 1.20.0 --inline # Generate inline snippet
#   ./scripts/update-formo-sdk.sh latest           # Use latest version

VERSION=${1:-latest}
MODE=${2:-hosted}  # 'hosted' or 'inline'

# If second arg is --inline, switch mode
if [ "$2" = "--inline" ]; then
  MODE="inline"
fi

DEST_DIR="public/libs/formo"
DEST_FILE="$DEST_DIR/$VERSION/analytics.min.js"
SDK_URL="https://unpkg.com/@formo/analytics@$VERSION/dist/index.umd.min.js"

echo "📦 Downloading Formo Analytics SDK version: $VERSION"

# Download SDK
echo "⬇️  Fetching from unpkg.com..."
SDK_CODE=$(curl -sSL "$SDK_URL")

if [ -z "$SDK_CODE" ] || [ "${SDK_CODE:0:1}" = "<" ]; then
  echo "❌ Error: Failed to download SDK"
  exit 1
fi

# Get the actual version if "latest" was requested
ACTUAL_VERSION=$VERSION
if [ "$VERSION" = "latest" ]; then
  ACTUAL_VERSION=$(curl -s "https://unpkg.com/@formo/analytics@latest/package.json" | grep '"version"' | head -1 | cut -d'"' -f4)
  echo "ℹ️  Latest version is: $ACTUAL_VERSION"
fi

# Generate SRI hash
HASH=$(echo "$SDK_CODE" | openssl dgst -sha384 -binary | openssl base64 -A)

# Get file size
FILE_SIZE=$(echo -n "$SDK_CODE" | wc -c | tr -d ' ')
FILE_SIZE_KB=$((FILE_SIZE / 1024))

if [ "$MODE" = "inline" ]; then
  # Generate inline snippet
  OUTPUT_DIR="dist"
  OUTPUT_FILE="$OUTPUT_DIR/inline-snippet-${ACTUAL_VERSION}.html"
  
  mkdir -p "$OUTPUT_DIR"
  
  cat > "$OUTPUT_FILE" <<EOF
<!-- 
  Formo Analytics SDK v${ACTUAL_VERSION} - Inline Installation
  
  This is a self-contained, inline version of the Formo Analytics SDK.
  No external dependencies required - everything is included in this snippet.
  
  Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
  Version: ${ACTUAL_VERSION}
  Size: ${FILE_SIZE_KB} KB
  Integrity: sha384-${HASH}
  
  Usage:
  1. Copy this entire snippet
  2. Paste into your HTML <head> section
  3. Replace YOUR_API_KEY with your actual Formo API key
  
  Documentation: https://docs.formo.so
  GitHub: https://github.com/getformo/sdk
-->
<script>
${SDK_CODE}
</script>
<script>
  // Initialize Formo Analytics
  if (typeof window.formofy === 'function') {
    window.formofy("YOUR_API_KEY", {
      debug: false, // Set to true for development/debugging
    });
  } else {
    console.error('❌ Formo Analytics failed to load');
  }
</script>
EOF

  echo ""
  echo "✅ Inline snippet generated successfully!"
  echo ""
  echo "📊 Details:"
  echo "   Version: $ACTUAL_VERSION"
  echo "   Size: ${FILE_SIZE_KB} KB"
  echo "   Integrity: sha384-$HASH"
  echo ""
  echo "📁 Saved to: $OUTPUT_FILE"
  echo ""
  echo "🎯 Next Steps:"
  echo "   1. Open the file: $OUTPUT_FILE"
  echo "   2. Copy the entire contents"
  echo "   3. Paste into your HTML <head>"
  echo "   4. Replace YOUR_API_KEY with your actual API key"
  echo ""
  
else
  # Hosted file mode
  mkdir -p "$DEST_DIR/$VERSION"
  
  # Save SDK file
  echo "$SDK_CODE" > "$DEST_FILE"
  
  # Download source map if available
  echo "⬇️  Fetching source map..."
  curl -sSL "https://unpkg.com/@formo/analytics@$VERSION/dist/index.umd.min.js.map" \
    -o "$DEST_FILE.map" 2>/dev/null || echo "⚠️  Source map not available"
  
  echo ""
  echo "✅ Downloaded to: $DEST_FILE"
  echo "📊 File size: ${FILE_SIZE_KB} KB"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📋 Installation Snippet"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Add this to your HTML <head>:"
  echo ""
  echo "<script"
  echo "  src=\"/libs/formo/$ACTUAL_VERSION/analytics.min.js\""
  echo "  integrity=\"sha384-$HASH\""
  echo "  crossorigin=\"anonymous\""
  echo "></script>"
  echo "<script>"
  echo "  window.formofy(\"YOUR_API_KEY\");"
  echo "</script>"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  # Create README
  cat > "$DEST_DIR/$ACTUAL_VERSION/README.md" <<EOF
# Formo Analytics SDK - Version $ACTUAL_VERSION

Downloaded on: $(date)
File size: ${FILE_SIZE_KB} KB
SRI Hash: sha384-$HASH

## Usage

\`\`\`html
<script
  src="/libs/formo/$ACTUAL_VERSION/analytics.min.js"
  integrity="sha384-$HASH"
  crossorigin="anonymous"
></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
\`\`\`

## Version Info

- Package: @formo/analytics
- Version: $ACTUAL_VERSION
- Source: https://unpkg.com/@formo/analytics@$ACTUAL_VERSION

## Files

- \`analytics.min.js\` - Minified SDK bundle
- \`analytics.min.js.map\` - Source map (if available)
- \`README.md\` - This file

## Documentation

- Website: https://formo.so
- Docs: https://docs.formo.so
- GitHub: https://github.com/getformo/sdk
EOF

  echo "📝 Created README at: $DEST_DIR/$ACTUAL_VERSION/README.md"
  echo ""
  echo "✨ Done! The SDK is ready to use."
fi
