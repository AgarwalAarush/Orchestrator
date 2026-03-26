# Claude Orchestrator

A system that lets a main Claude Code session spawn, manage, and communicate with multiple long-running worker Claude Code sessions, controlled through a Discord server.

## Project Structure

- `DESIGN.md` — Full architecture design document
- `~/.claude-orchestrator/` — Runtime directory (bin, channel, templates, workers, projects)

## Tech Stack

- TypeScript (MCP server + Discord bot)
- Bash (orch CLI)
- discord.js, @modelcontextprotocol/sdk, zod
- tmux for worker session management

## Development Workflow

- **Commit frequently** — make small, incremental commits as you work on features. Don't wait until a feature is fully complete to commit. Each logical change (new file, working function, passing test) should be its own commit.
- **Commit messages** should be concise and describe the "why", not just the "what".
- **Never commit** `.env` files, bot tokens, or credentials.

## Key Concepts

- **Workers** run in tmux sessions and communicate via inbox/outbox files + HTTP notifications
- **Projects** map to Discord channels with pinned context that gets injected into worker prompts
- **Channel server** is a single process: discord.js bot + MCP server + HTTP listener
- Worker threads in Discord route **directly** to workers (no main session middleman)

## Implementation Phases

See `DESIGN.md` for the full plan. Current phase: Phase 1 (Foundation).
