# Claude Orchestrator

Multi-worker Claude Code orchestrator controlled via Discord.

## MANDATORY ROUTING RULE

**When running as the orchestrator (with --channels), you are a ROUTER, not a worker.**

When a Discord message arrives from a PROJECT CHANNEL (any channel that matches a project in ~/.claude-orchestrator/channel-state.json):
1. Do NOT answer the question yourself. Do NOT analyze code, give opinions, or do any work.
2. Run `orch list` to check for a running worker for that project.
3. If worker exists → `route_to_worker(worker_name, message)` → reply "Routed to worker."
4. If no worker → `orch spawn <project-name> <project-dir> <prompt> --project <project-name>` → then route.
5. When worker posts notification → relay the response to Discord.

**The ONLY messages you handle directly are in #main.** Everything else goes to workers.

## Architecture

- **Official Discord plugin** handles all Discord ↔ Claude messaging
- **Companion MCP server** (`channel/src/`) provides orchestrator tools + HTTP listener on :9111
- **orch CLI** (`bin/orch`) manages worker lifecycle via tmux
- **Main session** is a thin router — routes project messages to workers, relays responses back
- **Workers** are full Claude Code sessions in tmux with project memory
- **Web dashboard** at `localhost:9111` when companion server is running

## Key Rules

- Main session NEVER does project work (SSH, code, SLURM, answering questions about code). Routes to workers.
- Every project channel message goes to that project's dedicated worker. NO EXCEPTIONS.
- Workers post responses via `curl POST localhost:9111/notify`.
- Workers stream incremental updates — post after each step, not just at the end.
- Workers write handoff memories before finishing or hitting context limits.
- Memory is file-based markdown with YAML frontmatter at `~/.claude-orchestrator/memory/`.

## Quick Start

```bash
orch start          # Launch orchestrator in tmux with Discord channels
orch stop           # Shut it down
orch attach <name>  # Jump into a worker's terminal
```

Dashboard: `http://localhost:9111` (when orchestrator is running)

## CLI Commands

```
orch spawn <n> <dir> <prompt> [--project p] [--template t] [--model m] [--after w]
orch send/status/list/logs/kill/attach/cleanup
orch start/stop
orch project create/update/link/archive/list
orch memory list/show/rebuild/promote/add/consolidate
```

## Development

- **Commit frequently** with concise messages.
- **Never commit** `.env`, bot tokens, or credentials.
- TypeScript changes: `cd channel && npx tsc --noEmit` to type-check.
- After changes: `bash install.sh` to copy to `~/.claude-orchestrator/`.
- Restart `claude --channels` session to pick up instruction changes.

## File Locations

- CLI: `bin/orch`
- Companion server: `channel/src/server.ts` (entry), `tools.ts`, `http.ts`, `state.ts`
- Dashboard: `channel/src/dashboard.ts`
- Monitor: `channel/src/monitor.ts` (heartbeat, auto-resume, dependency checks)
- Templates: `templates/*.md` (frontmatter `default_model` sets per-template model)
- Runtime: `~/.claude-orchestrator/` (installed by `install.sh`)
- Discord state: `~/.claude-orchestrator/channel-state.json`
- Discord access: `~/.claude/channels/discord/access.json`
- Web dashboard: `http://localhost:9111` (served by companion server)
