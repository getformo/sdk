#!/bin/bash
set -e

# Generate SRI Hash for a JavaScript file
# Usage: ./scripts/generate-sri-hash.sh <file-path>
# Example: ./scripts/generate-sri-hash.sh public/libs/formo/1.20.0/analytics.min.js

if [ -z "$1" ]; then
  echo "Usage: $0 <file-path>"
  echo "Example: $0 public/libs/formo/1.20.0/analytics.min.js"
  exit 1
fi

FILE_PATH="$1"

if [ ! -f "$FILE_PATH" ]; then
  echo "❌ Error: File not found: $FILE_PATH"
  exit 1
fi

echo "🔒 Generating SRI hash for: $FILE_PATH"
echo ""

# Generate SHA-256 hash
HASH_256=$(cat "$FILE_PATH" | openssl dgst -sha256 -binary | openssl base64 -A)

# Generate SHA-384 hash (recommended)
HASH_384=$(cat "$FILE_PATH" | openssl dgst -sha384 -binary | openssl base64 -A)

# Generate SHA-512 hash
HASH_512=$(cat "$FILE_PATH" | openssl dgst -sha512 -binary | openssl base64 -A)

echo "SHA-256: sha256-$HASH_256"
echo ""
echo "SHA-384: sha384-$HASH_384 (recommended)"
echo ""
echo "SHA-512: sha512-$HASH_512"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 HTML Script Tag (with SHA-384)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "<script"
echo "  src=\"/$FILE_PATH\""
echo "  integrity=\"sha384-$HASH_384\""
echo "  crossorigin=\"anonymous\""
echo "></script>"
echo ""

