#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

echo "✅ Commit completed successfully!"

# Run size-limit
npx size-limit
