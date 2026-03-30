# Claude Orchestrator

Multi-worker Claude Code orchestrator controlled via Discord.

## Architecture

- **Official Discord plugin** handles all Discord ↔ Claude messaging
- **Companion MCP server** (`channel/src/`) provides orchestrator tools + HTTP listener on :9111
- **orch CLI** (`bin/orch`) manages worker lifecycle via tmux
- **Main session** is a thin router — routes project messages to workers, relays responses back
- **Workers** are full Claude Code sessions in tmux with project memory

## Key Rules

- Main session NEVER does project work (SSH, code, SLURM). Routes to workers.
- Every project channel message goes to that project's dedicated worker.
- Workers post responses via `curl POST localhost:9111/notify`.
- Memory is file-based markdown with YAML frontmatter at `~/.claude-orchestrator/memory/`.

## Development

- **Commit frequently** with concise messages.
- **Never commit** `.env`, bot tokens, or credentials.
- TypeScript changes: `cd channel && npx tsc --noEmit` to type-check.
- After changes: `bash install.sh` to copy to `~/.claude-orchestrator/`.
- Restart `claude --channels` session to pick up instruction changes.

## File Locations

- CLI: `bin/orch`
- Companion server: `channel/src/server.ts` (entry), `tools.ts`, `http.ts`, `state.ts`
- Templates: `templates/*.md` (frontmatter `default_model` sets per-template model)
- Runtime: `~/.claude-orchestrator/` (installed by `install.sh`)
- Discord state: `~/.claude-orchestrator/channel-state.json`
- Discord access: `~/.claude/channels/discord/access.json`
