#!/bin/bash
set -e

PACKAGE_NAME="@formo/analytics"
PACKAGE_VERSION="$1"

CDN_URL="https://unpkg.com/${PACKAGE_NAME}@${PACKAGE_VERSION}/dist/index.umd.min.js"
HASH=$(curl -sSL --compressed "$CDN_URL" | openssl dgst -sha256 -binary | openssl base64 -A)

echo "<script src=\"https://unpkg.com/${PACKAGE_NAME}@${PACKAGE_VERSION}/dist/index.umd.min.js\"
        integrity=\"sha256-${HASH}\" crossorigin=\"anonymous\"></script>" > sri-snippet.txt
