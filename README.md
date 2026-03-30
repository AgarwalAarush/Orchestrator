# Claude Code Orchestrator

Spawn, manage, and communicate with multiple long-running Claude Code worker sessions — all controlled through Discord from any device.

Each project gets its own persistent worker with isolated context, accumulated memory, and SSH access to remote servers. Workers run autonomously in tmux and communicate back through Discord.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         DISCORD SERVER                            │
│                                                                  │
│  #main ──────────────── Orchestration commands                   │
│  #notifications ──────── Worker update feed                      │
│                                                                  │
│  Projects/                                                       │
│  ├── #moe-research ──── All messages route to moe-research worker│
│  └── #personal-website ─ All messages route to website worker    │
│                                                                  │
│  #tasks ──────────────── One-off workers (not project-scoped)    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                         Discord API
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│  YOUR MACHINE                │                                    │
│                              ▼                                    │
│  ┌────────────────────────────────────────────┐                  │
│  │  OFFICIAL DISCORD PLUGIN (channel)         │                  │
│  │  Handles all Discord ↔ Claude messaging    │                  │
│  │  Tools: reply, react, edit, fetch_messages │                  │
│  │  Permission relay (approve from phone)     │                  │
│  └──────────────────┬─────────────────────────┘                  │
│                     │                                             │
│                     ▼                                             │
│  ┌────────────────────────────────────────────┐                  │
│  │  MAIN CLAUDE SESSION (thin router)         │                  │
│  │                                            │                  │
│  │  #main messages → handles directly         │                  │
│  │  Project messages → routes to worker       │                  │
│  │  Worker notifications → relays to Discord  │                  │
│  │                                            │                  │
│  │  Does NOT do project work itself.          │                  │
│  └─────┬──────────────────────────┬───────────┘                  │
│        │ bash (orch CLI)          │ stdio (MCP)                  │
│        ▼                          ▼                              │
│  ┌──────────────┐    ┌─────────────────────────┐                 │
│  │  ORCH CLI    │    │  COMPANION MCP SERVER    │                 │
│  │              │    │                          │                 │
│  │  spawn       │    │  HTTP :9111              │                 │
│  │  send        │    │  ← workers POST updates  │                 │
│  │  kill        │    │  → Discord REST API      │                 │
│  │  status      │    │  → relay to main session │                 │
│  │  list        │    │                          │                 │
│  │  project     │    │  Tools:                  │                 │
│  │  memory      │    │  create_worker_thread    │                 │
│  └──────┬───────┘    │  update_status           │                 │
│         │            │  post_notification        │                 │
│    tmux manages      │  create_project_channel   │                 │
│    all workers       │  route_to_worker          │                 │
│         │            └─────────────▲─────────────┘                │
│         │                          │                              │
│  ┌──────┼──────────────────────────┼────────────────────┐        │
│  │      ▼              curl :9111  │                    │        │
│  │  ┌─────────┐    ┌─────────┐    │    ┌─────────┐     │        │
│  │  │ worker  │    │ worker  │    │    │ worker  │     │        │
│  │  │ moe-    │    │ personal│    │    │ one-off │     │        │
│  │  │ research│    │ -website│    │    │ task    │     │        │
│  │  │ (tmux)  │    │ (tmux)  │    │    │ (tmux)  │     │        │
│  │  │         │    │         │    │    │         │     │        │
│  │  │ Claude  │    │ Claude  │    │    │ Claude  │     │        │
│  │  │ Code    │    │ Code    │    │    │ Code    │     │        │
│  │  │ session │    │ session │    │    │ session │     │        │
│  │  └────┬────┘    └────┬────┘    │    └────┬────┘     │        │
│  │       │              │         │         │          │        │
│  │       ▼              ▼         │         ▼          │        │
│  │    ssh to         local      posts    any task      │        │
│  │    SLURM          code       updates                │        │
│  │    cluster        changes                           │        │
│  └─────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌────────────────────────────────────────────┐                  │
│  │  MEMORY SYSTEM (file-based, persistent)    │                  │
│  │                                            │                  │
│  │  ~/.claude-orchestrator/memory/user/        │                  │
│  │    SSH configs, preferences, patterns      │                  │
│  │                                            │                  │
│  │  ~/.claude-orchestrator/projects/*/memory/  │                  │
│  │    Per-project learnings, what worked/not  │                  │
│  │                                            │                  │
│  │  Injected into worker prompts at spawn.    │                  │
│  │  Workers write new memories mid-task.      │                  │
│  └────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

## Message Flow

```
You message in #moe-research: "check job status"
       │
       ▼
Official Discord plugin pushes to main session
       │
       ▼
Main session checks: is this a project channel? Yes → moe-research
       │
       ▼
Is there a running worker for moe-research?
       │
       ├── Yes → route_to_worker("moe-research", "check job status")
       │
       └── No  → orch spawn moe-research ... --project moe-research
                  route_to_worker("moe-research", "check job status")
       │
       ▼
Worker receives message in inbox, does the work:
  ssh aarusha@login.babel.cs.cmu.edu "squeue -u aarusha"
       │
       ▼
Worker posts response:
  curl POST localhost:9111/notify
  {"worker":"moe-research","event":"update","summary":"Job 6874557 running, step 3660/4056..."}
       │
       ▼
Companion server receives, posts to Discord + notifies main session
       │
       ▼
Main session relays to #moe-research via Discord reply tool
       │
       ▼
You see the response in Discord
```

## Features

- **Project isolation** — Each project gets its own Claude worker with dedicated context window
- **Persistent memory** — Learnings accumulate across sessions (SSH configs, experiment results, decisions)
- **Discord control** — Manage everything from your phone
- **Autonomous workers** — Run in tmux, survive terminal close, SSH into remote servers
- **Smart model selection** — Templates default to the right model (haiku for monitoring, opus for code)
- **Worker notifications** — Updates posted to Discord + #notifications feed
- **Permission relay** — Approve tool use from Discord on your phone

## Setup

### Prerequisites

```bash
brew install tmux
```

### 1. Install

```bash
git clone <this-repo>
cd claude-orchestrator
bash install.sh
```

### 2. Discord

Install the official Discord plugin in Claude Code:
```
/plugin install discord@claude-plugins-official
/discord:configure <your-bot-token>
/discord:access pair <code>       # after DMing the bot
/discord:access policy allowlist  # lock it down
```

Create a Discord server with channels: `#main`, `#notifications`, `#tasks`.
Or run the setup script to create them automatically:
```bash
cd ~/.claude-orchestrator/channel
DISCORD_BOT_TOKEN=<token> GUILD_ID=<id> npx tsx src/setup.ts
```

### 3. Register Companion Server

```bash
claude mcp add-json -s user orchestrator-companion '{
  "command": "npx",
  "args": ["--prefix", "~/.claude-orchestrator/channel", "tsx",
           "~/.claude-orchestrator/channel/src/server.ts"],
  "env": {
    "DISCORD_BOT_TOKEN": "<your-token>",
    "GUILD_ID": "<your-guild-id>",
    "NOTIFICATIONS_CHANNEL_ID": "<id>",
    "TASKS_CHANNEL_ID": "<id>",
    "ORCH_PORT": "9111",
    "ORCH_HOME": "~/.claude-orchestrator"
  }
}'
```

### 4. Launch

```bash
claude --channels plugin:discord@claude-plugins-official \
       --dangerously-load-development-channels server:orchestrator-companion
```

## CLI Reference

```
orch spawn <name> <dir> <prompt> [options]    Spawn a worker
  --ssh <user@host>                           SSH target
  --project <name>                            Attach to project
  --template <name>                           Template (default|slurm-monitor|code-worker|ssh-worker)
  --model <model>                             Model override

orch send <name> <message>                    Send directive to worker
orch status [name]                            Show worker status
orch list                                     List all workers
orch logs <name> [--tail N]                   Show terminal output
orch kill <name> [--rm]                       Stop worker (--rm removes state)
orch cleanup                                  Remove dead workers >24h

orch project create <name> <context>          Create project
orch project update <name> <context>          Update context
orch project link <name> <chan_id> <msg_id>   Link to Discord
orch project archive <name>                   Archive project
orch project list                             List projects

orch memory list [--user] [--project <name>]  List memories
orch memory show <layer>:<id>                 Show memory file
orch memory rebuild [--all]                   Rebuild indexes
orch memory promote <worker> <id> --to <dst>  Promote worker memory
orch memory add <layer> <id> <title> [opts]   Create memory
```

## Templates & Model Selection

| Template | Default Model | Use For |
|----------|--------------|---------|
| `default` | sonnet | General purpose |
| `slurm-monitor` | haiku | Job monitoring, status polling |
| `code-worker` | opus | Code refactoring, implementation |
| `ssh-worker` | sonnet | Remote server tasks |

Templates have YAML frontmatter with `default_model`. Override with `--model`.

## Memory System

File-based persistent memory with YAML frontmatter:

```
~/.claude-orchestrator/
├── memory/user/              # Global: SSH configs, preferences
├── memory/patterns/          # Cross-project recurring patterns
└── projects/*/memory/        # Per-project: learnings, decisions, warnings
```

Memory indexes are injected into worker system prompts at spawn time.
Workers can write new memories mid-task. Categories: `environment`,
`experiment-result`, `decision`, `preference`, `procedure`, `warning`, `reference`.

## File Structure

```
~/.claude-orchestrator/
├── bin/orch                  # CLI (bash)
├── channel/
│   └── src/
│       ├── server.ts         # Companion MCP server entry point
│       ├── discord-rest.ts   # Discord REST API (no gateway)
│       ├── tools.ts          # MCP tools for Claude
│       ├── state.ts          # Persisted state (projects, workers)
│       ├── http.ts           # HTTP :9111 for worker notifications
│       ├── direct.ts         # Direct worker inbox routing
│       ├── monitor.ts        # Heartbeat stale worker detection
│       └── setup.ts          # One-time Discord channel setup
├── templates/
│   ├── default.md            # General worker template
│   ├── slurm-monitor.md      # SLURM monitoring (haiku)
│   ├── code-worker.md        # Code work (opus)
│   └── ssh-worker.md         # SSH remote (sonnet)
├── hooks/
│   └── notify-main.sh        # PostToolUse: heartbeat + inbox check
├── memory/
│   ├── user/                 # Global user memories
│   └── patterns/             # Cross-project patterns
├── projects/                 # Project metadata + memory
├── workers/                  # Runtime worker state
└── config.json               # Global configuration
```

## Design Documents

- [DESIGN.md](DESIGN.md) — Full architecture, communication flows, Discord server structure
- [MEMORY-DESIGN.md](MEMORY-DESIGN.md) — Memory system architecture, file format, lifecycle

## License

MIT
