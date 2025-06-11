#!/bin/bash
set -e

VERSION=$1
REPO="getformo/sdk"
FILE="dist/index.umd.min.js"
PACKAGE_NAME="@formo/analytics"

# Get the tarball from unpkg and compute SRI
URL="https://unpkg.com/${PACKAGE_NAME}@${VERSION}/${FILE}"
echo "Fetching: $URL"
HASH=$(curl -sSL --compressed $URL | openssl dgst -sha384 -binary | openssl base64 -A)

echo "Hash: $HASH"

SNIPPET=$(cat <<EOF
<script 
  src="${URL}"
  integrity="sha384-${HASH}"
  crossorigin="anonymous"
></script>
EOF
)

# Get the release ID from GitHub API
RELEASE_ID=$(curl -s -H "Authorization: Bearer $GH_RELEASE_TOKEN" \
  https://api.github.com/repos/${REPO}/releases/tags/v${VERSION} \
  | jq -r '.id')

# Fetch current body
CURRENT_BODY=$(curl -s -H "Authorization: Bearer $GH_RELEASE_TOKEN" \
  https://api.github.com/repos/${REPO}/releases/$RELEASE_ID \
  | jq -r '.body')

# Append SRI snippet
UPDATED_BODY=$(cat <<EOF
${CURRENT_BODY}

🔒 **Subresource Integrity Snippet**

\`\`\`html
${SNIPPET}
\`\`\`
EOF
)

# Patch the release body
curl -s -X PATCH \
  -H "Authorization: Bearer $GH_RELEASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg body "$UPDATED_BODY" '{body: $body}')" \
  https://api.github.com/repos/${REPO}/releases/$RELEASE_ID

echo "✅ GitHub Release updated with SRI snippet."
