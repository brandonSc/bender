#!/bin/bash
# Usage: bender-gh-token <org-name>
# Example: bender-gh-token pantalasa
#
# Returns a fresh GitHub installation token for the given org.
# The token is printed to stdout (no extra output).
# Available orgs: earthly, pantalasa, pantalasa-cronos, brandonSc
#
# Useful for cross-org operations:
#   git remote set-url origin "https://x-access-token:$(bender-gh-token pantalasa)@github.com/pantalasa/lunar.git"
#   git push

ORG="$1"

if [ -z "$ORG" ]; then
  echo "Usage: bender-gh-token <org-name>" >&2
  echo "Available orgs: earthly, pantalasa, pantalasa-cronos, brandonSc" >&2
  exit 1
fi

RESULT=$(curl -sf "http://localhost:3000/internal/github-token?org=$ORG" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  echo "Failed to get token for org '$ORG'" >&2
  exit 1
fi

TOKEN=$(echo "$RESULT" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
  ERROR=$(echo "$RESULT" | jq -r '.error // "Unknown error"')
  AVAILABLE=$(echo "$RESULT" | jq -r '.available // [] | join(", ")')
  echo "Error: $ERROR" >&2
  [ -n "$AVAILABLE" ] && echo "Available orgs: $AVAILABLE" >&2
  exit 1
fi

echo "$TOKEN"
