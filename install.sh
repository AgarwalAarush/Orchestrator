#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Claude Code Orchestrator — Installer
# Sets up ~/.claude-orchestrator/ with the CLI, templates, hooks, and config.
# =============================================================================

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCH_HOME="$HOME/.claude-orchestrator"

echo "Installing Claude Code Orchestrator..."
echo ""

# Check prerequisites
if ! command -v tmux &>/dev/null; then
  echo "error: tmux is not installed." >&2
  echo "  Install with: brew install tmux" >&2
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "error: claude CLI is not installed." >&2
  echo "  Install from: https://claude.ai/download" >&2
  exit 1
fi

echo "  tmux:  $(which tmux) ($(tmux -V))"
echo "  claude: $(which claude) ($(claude --version 2>/dev/null || echo 'unknown'))"
echo ""

# Create directory structure
echo "Creating $ORCH_HOME/..."
mkdir -p "$ORCH_HOME/bin"
mkdir -p "$ORCH_HOME/templates"
mkdir -p "$ORCH_HOME/hooks"
mkdir -p "$ORCH_HOME/workers"
mkdir -p "$ORCH_HOME/projects"

# Copy files
echo "Copying files..."
cp "$REPO_DIR/bin/orch" "$ORCH_HOME/bin/orch"
cp "$REPO_DIR/templates/default.md" "$ORCH_HOME/templates/default.md"
cp "$REPO_DIR/hooks/notify-main.sh" "$ORCH_HOME/hooks/notify-main.sh"

# Only copy config if it doesn't exist (don't overwrite user customizations)
if [ ! -f "$ORCH_HOME/config.json" ]; then
  cp "$REPO_DIR/config.json" "$ORCH_HOME/config.json"
  echo "  Created config.json (edit to customize)"
else
  echo "  config.json already exists (skipped)"
fi

# Make scripts executable
chmod +x "$ORCH_HOME/bin/orch"
chmod +x "$ORCH_HOME/hooks/notify-main.sh"

# Symlink to ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$ORCH_HOME/bin/orch" "$HOME/.local/bin/orch"

# Install channel dependencies
if [ -f "$REPO_DIR/channel/package.json" ]; then
  echo ""
  echo "Installing channel server dependencies..."
  mkdir -p "$ORCH_HOME/channel"
  cp -r "$REPO_DIR/channel/src" "$ORCH_HOME/channel/src"
  cp "$REPO_DIR/channel/package.json" "$ORCH_HOME/channel/package.json"
  cp "$REPO_DIR/channel/package-lock.json" "$ORCH_HOME/channel/package-lock.json" 2>/dev/null || true
  cp "$REPO_DIR/channel/tsconfig.json" "$ORCH_HOME/channel/tsconfig.json"
  if [ ! -f "$ORCH_HOME/channel/.env" ]; then
    cp "$REPO_DIR/channel/.env.example" "$ORCH_HOME/channel/.env.example"
    echo "  Created .env.example (copy to .env and add your bot token)"
  fi
  (cd "$ORCH_HOME/channel" && npm install --silent 2>/dev/null)
  echo "  Channel server installed"
fi

# Check PATH
if ! echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin"; then
  echo ""
  echo "warning: ~/.local/bin is not on your PATH."
  echo "  Add to your shell config:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

echo ""
echo "Installation complete!"
echo ""
echo "  orch help     — show available commands"
echo "  orch spawn    — create a new worker"
echo "  orch list     — see all workers"
echo ""
echo "Config: $ORCH_HOME/config.json"
echo "Workers: $ORCH_HOME/workers/"
echo ""
echo "For Discord integration:"
echo "  1. Create a Discord bot at discord.com/developers"
echo "  2. Copy $ORCH_HOME/channel/.env.example to $ORCH_HOME/channel/.env"
echo "  3. Add your bot token and guild ID"
echo "  4. Update discord section in $ORCH_HOME/config.json with channel IDs"
