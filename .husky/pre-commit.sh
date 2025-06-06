#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

echo "Running pre-commit process..."

# Example: fix formatting using Prettier
npx genversion --esm --semi src/lib/version.ts

# Add modified files to Git staging
git add .