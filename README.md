# Claude Orchestrator

A system that lets a main Claude Code session spawn, manage, and communicate with multiple long-running worker Claude Code sessions — all controlled through a Discord server.

Coordinate complex multi-worker tasks from any device (phone, tablet, laptop) through Discord messaging. Workers run autonomously in tmux sessions and communicate back through Discord threads.

## How It Works

```
Discord                          Local Machine
┌─────────────┐                  ┌──────────────────────┐
│ #main       │ ◄──────────────► │ Main Claude Session  │
│ #project-x  │                  │                      │
│  └─ worker1 │ ◄─── direct ──► │ tmux: worker1        │
│  └─ worker2 │ ◄─── direct ──► │ tmux: worker2        │
│ #notifs     │ ◄── updates ──  │ tmux: worker3        │
└─────────────┘                  └──────────────────────┘
```

- **#main** — Talk to the orchestrator to create projects and spawn workers
- **Project channels** — Scoped context shared with all workers in that project
- **Worker threads** — Route **directly** to worker inboxes (no main session bottleneck)
- **#notifications** — Glanceable feed of worker updates with emoji status

## Key Features

- **Direct worker communication** — Messages in worker threads go straight to the worker via inbox files + tmux nudge, scaling to 8+ concurrent workers
- **Projects** — Discord channels with pinned context that gets injected into every worker's prompt
- **Autonomous workers** — Workers run in tmux, survive terminal close and laptop sleep, and post updates back to Discord
- **Mobile-friendly** — Control everything from your phone through Discord

## Tech Stack

- **CLI**: Bash (`bin/orch`)
- **Channel Server**: TypeScript (discord.js + MCP SDK)
- **Process Management**: tmux
- **State**: JSON files on disk

## Setup

### Prerequisites

```bash
brew install tmux node
```

### 1. Discord Bot

1. Create a Discord server
2. Create a bot at https://discord.com/developers/applications
3. Enable **Message Content Intent**
4. Add bot to your server with permissions: View Channels, Send Messages, Send/Create/Manage Threads, Manage Channels, Read Message History, Attach Files, Add Reactions, Embed Links
5. Create channels: `#main`, `#notifications`, `#tasks`

### 2. Install

```bash
# Set up runtime directory
mkdir -p ~/.claude-orchestrator/{bin,channel,templates,hooks,workers,projects}

# Copy files from this repo to ~/.claude-orchestrator/
# Make CLI executable
chmod +x ~/.claude-orchestrator/bin/orch
```

### 3. Channel Server

```bash
cd ~/.claude-orchestrator/channel
npm install

# Configure
cp .env.example .env
# Edit .env with your DISCORD_BOT_TOKEN and GUILD_ID

# Run
npm run dev
```

### 4. Launch Main Session

```bash
claude --channels orchestrator-discord \
       --dangerously-load-development-channels \
       --name "orchestrator"
```

## Usage

**Create a project:**
> You in #main: "create a project for my ML training work on cluster.edu"
>
> Bot creates #ml-training with pinned context

**Spawn a worker:**
> You in #main: "spawn a worker in #ml-training to start training run 005"
>
> Bot creates worker thread and starts a tmux session

**Direct a worker in real-time:**
> You in worker thread: "also log learning rate to CSV each epoch"
>
> Worker reads directive from inbox and adapts

**Monitor at a glance:**
> #notifications shows:
> - :white_check_mark: [gpu-train-005] 76.8% top-1. New best.
> - :hourglass_flowing_sand: [eval-pipeline] Evaluating checkpoint 3/5

## Project Structure

```
~/.claude-orchestrator/
├── bin/orch              # CLI for worker lifecycle
├── channel/              # Discord bot + MCP server
│   └── src/
│       ├── server.ts     # Entry point
│       ├── discord-rest.ts # Discord API wrapper
│       ├── tools.ts      # MCP tools
│       ├── state.ts      # State persistence
│       └── http.ts       # HTTP listener for worker updates
├── templates/            # Worker system prompt templates
├── hooks/                # Claude Code hooks (inbox check, heartbeat)
├── workers/              # Runtime worker directories
├── projects/             # Project metadata
└── config.json           # Global config
```

## Next Steps

### Intelligent Model Routing

Not every task needs the same model. The orchestrator should analyze incoming tasks and automatically select the right Anthropic model:

| Model | Best For | Examples |
|-------|----------|---------|
| **Haiku** | Monitoring, status checks, simple file ops | `slurm-watch`, log tailing, health checks |
| **Sonnet** | Standard code tasks, moderate reasoning | Feature implementation, refactoring, test writing |
| **Opus** | Complex architecture, multi-file reasoning, ambiguous specs | System design, debugging subtle issues, cross-repo changes |

The routing system will classify tasks by complexity signals (scope, ambiguity, reasoning depth) and select the cheapest model that can handle the job. Workers can also escalate mid-task — a Haiku monitor that detects an anomaly can flag it for an Opus worker to investigate.

### Remaining Implementation

- **Permission relay** — Surface Claude Code permission requests in Discord worker threads for approval
- **State recovery** — Persist channel server state to disk, reload on restart
- **iMessage integration** — Lightweight pings to Apple devices on worker completion/error
- **Heartbeat monitoring** — Detect dead workers and alert in Discord
- **Worker-to-worker communication** — Shared project state or direct inbox routing between workers
- **Rich embeds** — Better-formatted status messages and notifications in Discord
- **Discord rate limit handling** — Debounce with 8+ concurrent workers

See [DESIGN.md](DESIGN.md) for the full architecture and phased implementation plan.

## License

MIT
