#!/bin/bash
# PostToolUse hook for Claude Code Orchestrator workers.
# Updates heartbeat and checks inbox for new directives.
# Expects ORCH_WORKER_NAME and ORCH_HOME to be set in the environment.

WORKER_NAME="${ORCH_WORKER_NAME:-}"
ORCH_HOME="${ORCH_HOME:-$HOME/.claude-orchestrator}"

if [ -z "$WORKER_NAME" ]; then
  exit 0
fi

WORKER_DIR="$ORCH_HOME/workers/$WORKER_NAME"

if [ ! -d "$WORKER_DIR" ]; then
  exit 0
fi

# Update heartbeat
date +%s > "$WORKER_DIR/heartbeat" 2>/dev/null

# Check for unread inbox messages
INBOX_COUNT=0
if [ -d "$WORKER_DIR/inbox" ]; then
  INBOX_COUNT=$(find "$WORKER_DIR/inbox" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
fi

if [ "$INBOX_COUNT" -gt 0 ]; then
  echo "You have $INBOX_COUNT unread directive(s) in your inbox. Read files in $WORKER_DIR/inbox/ now and process them in order." >&2
fi
