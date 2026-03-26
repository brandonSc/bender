#!/bin/bash
# Usage: bender-say <type> <message>
# Types: thought, response, error, elicitation
# 
# Called by Claude during a session to post messages to the Linear AgentSession.
# Reads BENDER_AGENT_SESSION_ID and BENDER_LINEAR_TOKEN from environment.

TYPE="${1:-thought}"
shift
MESSAGE="$*"

if [ -z "$MESSAGE" ]; then
  echo "Usage: bender-say <thought|response|error|elicitation> <message>" >&2
  exit 1
fi

if [ -z "$BENDER_AGENT_SESSION_ID" ] || [ -z "$BENDER_LINEAR_TOKEN" ]; then
  echo "Missing BENDER_AGENT_SESSION_ID or BENDER_LINEAR_TOKEN env vars" >&2
  exit 1
fi

# Build the content JSON based on type
case "$TYPE" in
  thought|response|error|elicitation)
    CONTENT=$(jq -n --arg type "$TYPE" --arg body "$MESSAGE" '{type: $type, body: $body}')
    ;;
  *)
    echo "Unknown type: $TYPE (use thought, response, error, or elicitation)" >&2
    exit 1
    ;;
esac

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $BENDER_LINEAR_TOKEN" \
  -d "$(jq -n \
    --arg sessionId "$BENDER_AGENT_SESSION_ID" \
    --argjson content "$CONTENT" \
    '{
      query: "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      variables: { input: { agentSessionId: $sessionId, content: $content } }
    }')" \
  -o /dev/null -w "%{http_code}"

echo ""
