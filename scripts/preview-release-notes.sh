#!/bin/bash

# Preview release notes generator
# This simulates what the GitHub Actions workflow will generate

set -e

echo "🔍 Generating release notes preview..."
echo ""

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version in package.json: $CURRENT_VERSION"

# Simulate what the next version would be
NEXT_PATCH=$(echo $CURRENT_VERSION | awk -F. '{$NF = $NF + 1;} 1' | sed 's/ /./g')
NEXT_MINOR=$(echo $CURRENT_VERSION | awk -F. '{$(NF-1) = $(NF-1) + 1; $NF = 0;} 1' | sed 's/ /./g')
NEXT_MAJOR=$(echo $CURRENT_VERSION | awk -F. '{$1 = $1 + 1; $2 = 0; $NF = 0;} 1' | sed 's/ /./g')

echo "Next patch would be: $NEXT_PATCH"
echo "Next minor would be: $NEXT_MINOR"
echo "Next major would be: $NEXT_MAJOR"
echo ""

# Get previous tag
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -z "$PREV_TAG" ]; then
    echo "❌ No previous tag found"
    exit 1
fi

echo "📋 Generating changelog from $PREV_TAG to HEAD"
echo ""

# Get release date
RELEASE_DATE=$(date +%Y-%m-%d)
VERSION=$NEXT_PATCH

# Generate changelog with categorization
# Use tab as delimiter to safely handle semicolons and special characters
COMMITS=$(git log ${PREV_TAG}..HEAD --pretty=format:"%s	%h" --no-merges)

if [ -z "$COMMITS" ]; then
    echo "⚠️  No new commits since $PREV_TAG"
    echo ""
    echo "Using last 5 commits as example:"
    COMMITS=$(git log --pretty=format:"%s	%h" --no-merges -5)
fi

# Process commits and categorize
FEATURES=""
FIXES=""
OTHER=""

while IFS=$'\t' read -r message hash; do
    # Skip empty lines
    [ -z "$message" ] && continue
    
    # Extract PR number if exists
    if [[ $message =~ \(#([0-9]+)\) ]]; then
        PR_NUM="${BASH_REMATCH[1]}"
        ITEM="$message ([#$PR_NUM](https://github.com/getformo/sdk/pull/$PR_NUM)) ([$hash](https://github.com/getformo/sdk/commit/$hash))"
    else
        ITEM="$message ([$hash](https://github.com/getformo/sdk/commit/$hash))"
    fi
    
    # Categorize by prefix and strip conventional commit prefix
    if [[ $message =~ ^feat(\([^\)]+\))?: ]]; then
        # Strip "feat:" or "feat(scope):" from the beginning of ITEM
        STRIPPED_ITEM=$(echo "$ITEM" | sed -E 's/^feat(\([^)]+\))?: //')
        FEATURES="${FEATURES}- ${STRIPPED_ITEM}
"
    elif [[ $message =~ ^fix(\([^\)]+\))?: ]]; then
        # Strip "fix:" or "fix(scope):" from the beginning of ITEM
        STRIPPED_ITEM=$(echo "$ITEM" | sed -E 's/^fix(\([^)]+\))?: //')
        FIXES="${FIXES}- ${STRIPPED_ITEM}
"
    else
        OTHER="${OTHER}- ${ITEM}
"
    fi
done <<< "$COMMITS"

# Create preview
cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 RELEASE NOTES PREVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

$VERSION ($RELEASE_DATE)
EOF

# Add Features section if exists
if [ -n "$FEATURES" ]; then
    cat <<EOF

## Features

$FEATURES
EOF
fi

# Add Fixes section if exists
if [ -n "$FIXES" ]; then
    cat <<EOF

## Bug Fixes

$FIXES
EOF
fi

# Add Other changes if exists and no features/fixes
if [ -z "$FEATURES" ] && [ -z "$FIXES" ] && [ -n "$OTHER" ]; then
    cat <<EOF

## Changes

$OTHER
EOF
fi

# Add npm package link
cat <<EOF

## Install

This release is available on NPM and CDN.

### NPM

[npm package](https://www.npmjs.com/package/@formo/analytics/v/$VERSION) (@latest dist-tag)

### CDN

\`\`\`html
<script 
  src="https://cdn.formo.so/analytics@$VERSION"
  integrity="sha384-[HASH_WILL_BE_GENERATED_AFTER_PUBLISH]"
  crossorigin="anonymous"
></script>
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📝 Note: This is a preview based on commits since $PREV_TAG
   The actual release notes will be generated when you run:
   
   npm version patch  # (or minor/major)
   git push --follow-tags

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF

