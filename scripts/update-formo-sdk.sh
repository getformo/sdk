#!/bin/bash
set -e

# Self-Hosting Update Script
# Downloads the Formo Analytics SDK from npm CDN and generates SRI hash
# Usage: ./scripts/update-formo-sdk.sh [version]
# Example: ./scripts/update-formo-sdk.sh 1.20.0
# Example: ./scripts/update-formo-sdk.sh latest

VERSION=${1:-latest}
DEST_DIR="public/libs/formo"
DEST_FILE="$DEST_DIR/$VERSION/analytics.min.js"

echo "📦 Downloading Formo Analytics SDK version: $VERSION"

# Create directory
mkdir -p "$DEST_DIR/$VERSION"

# Download from npm CDN (unpkg)
echo "⬇️  Fetching from unpkg.com..."
HTTP_STATUS=$(curl -L -w "%{http_code}" -o "$DEST_FILE" \
  "https://unpkg.com/@formo/analytics@$VERSION/dist/index.umd.min.js")

if [ "$HTTP_STATUS" != "200" ]; then
  echo "❌ Error: Failed to download SDK (HTTP $HTTP_STATUS)"
  rm -f "$DEST_FILE"
  exit 1
fi

# Download source map if available
echo "⬇️  Fetching source map..."
curl -L "https://unpkg.com/@formo/analytics@$VERSION/dist/index.umd.min.js.map" \
  -o "$DEST_FILE.map" 2>/dev/null || echo "⚠️  Source map not available"

# Get the actual version if "latest" was requested
if [ "$VERSION" = "latest" ]; then
  ACTUAL_VERSION=$(curl -s "https://unpkg.com/@formo/analytics@latest/package.json" | grep '"version"' | head -1 | cut -d'"' -f4)
  echo "ℹ️  Latest version is: $ACTUAL_VERSION"
fi

# Generate SRI hash
echo "🔒 Generating SRI hash..."
HASH=$(cat "$DEST_FILE" | openssl dgst -sha384 -binary | openssl base64 -A)

# Get file size
FILE_SIZE=$(wc -c < "$DEST_FILE" | tr -d ' ')
FILE_SIZE_KB=$((FILE_SIZE / 1024))

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
echo "  src=\"/libs/formo/$VERSION/analytics.min.js\""
echo "  integrity=\"sha384-$HASH\""
echo "  crossorigin=\"anonymous\""
echo "></script>"
echo "<script>"
echo "  window.formofy(\"YOUR_API_KEY\");"
echo "</script>"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create a README in the version directory
cat > "$DEST_DIR/$VERSION/README.md" <<EOF
# Formo Analytics SDK - Version $VERSION

Downloaded on: $(date)
File size: ${FILE_SIZE_KB} KB
SRI Hash: sha384-$HASH

## Usage

\`\`\`html
<script
  src="/libs/formo/$VERSION/analytics.min.js"
  integrity="sha384-$HASH"
  crossorigin="anonymous"
></script>
<script>
  window.formofy("YOUR_API_KEY");
</script>
\`\`\`

## Version Info

- Package: @formo/analytics
- Version: $VERSION
- Source: https://unpkg.com/@formo/analytics@$VERSION

## Files

- \`analytics.min.js\` - Minified SDK bundle
- \`analytics.min.js.map\` - Source map (if available)
- \`README.md\` - This file

## Documentation

- Website: https://formo.so
- Docs: https://docs.formo.so
- GitHub: https://github.com/getformo/sdk
EOF

echo "📝 Created README at: $DEST_DIR/$VERSION/README.md"
echo ""
echo "✨ Done! The SDK is ready to use."

