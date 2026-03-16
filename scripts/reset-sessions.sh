#!/usr/bin/env bash
# Reset all group sessions and kill running containers.
# Run this after editing any CLAUDE.md file or changing container config.
# Usage: ./scripts/reset-sessions.sh [group_folder]
#   No args: resets ALL groups
#   With arg: resets only the named group (e.g. whatsapp_main)

set -euo pipefail

DB="$(dirname "$0")/../store/messages.db"

if [ $# -eq 0 ]; then
  echo "Stopping all running nanoclaw containers..."
  CONTAINERS=$(docker ps --filter name=nanoclaw --format "{{.Names}}" 2>/dev/null || true)
  if [ -n "$CONTAINERS" ]; then
    echo "$CONTAINERS" | xargs docker stop
    echo "Stopped: $CONTAINERS"
  else
    echo "No containers running."
  fi

  echo "Clearing all sessions..."
  sqlite3 "$DB" "DELETE FROM sessions;"
  echo "Done — next message in each group will start a fresh container."
else
  GROUP="$1"
  CONTAINER_PATTERN="nanoclaw-$(echo "$GROUP" | tr '_' '-')"

  echo "Stopping containers matching $CONTAINER_PATTERN..."
  CONTAINERS=$(docker ps --filter "name=$CONTAINER_PATTERN" --format "{{.Names}}" 2>/dev/null || true)
  if [ -n "$CONTAINERS" ]; then
    echo "$CONTAINERS" | xargs docker stop
    echo "Stopped: $CONTAINERS"
  else
    echo "No matching containers running."
  fi

  echo "Clearing session for $GROUP..."
  sqlite3 "$DB" "DELETE FROM sessions WHERE group_folder='$GROUP';"
  echo "Done — next message in $GROUP will start a fresh container."
fi
