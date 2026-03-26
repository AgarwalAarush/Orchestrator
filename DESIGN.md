# Claude Code Orchestrator — Architecture Design

## Overview

A system that lets a **main Claude Code session** spawn, manage, and communicate with **multiple long-running worker Claude Code sessions**, controlled entirely through a **Discord server**. Workers run autonomously in tmux, can SSH into remote servers, and report back via a **custom Discord Channel** (MCP server).

The Discord server is structured around **projects**. Each project gets its own Discord channel with persistent context (pinned), and workers spawn as threads within their project. This keeps related work grouped and gives workers automatic project context.

An optional **iMessage channel** provides lightweight notification pings to Apple devices.

---

## Requirements

| # | Requirement | Solution |
|---|-------------|----------|
| 1 | Workers run on remote servers via SSH | Workers execute `ssh` commands from local tmux sessions |
| 2 | Send high-level directives to workers mid-task | Message the worker's Discord thread (routed directly, no middleman) |
| 3 | Receive updates on-demand | Ask in Discord #main, or check worker thread |
| 4 | Receive notifications when workers finish | Bot posts in worker thread + #notifications feed |
| 5 | Persist across laptop sleep | tmux sessions survive terminal close; Discord bot stays connected |
| 6 | Scale to 8+ concurrent workers | One thread per worker, file-based state, no shared state |
| 7 | Control from any device | Discord app on phone/tablet/browser |
| 8 | Project-scoped context | Each project channel has pinned context injected into its workers |
| 9 | Direct worker communication | Worker threads bypass main session — channel server routes directly |

---

## Discord Server Structure

```
Server: "Claude Orchestrator"
│
├── #main
│   Purpose: Talk to the main Claude session. Anything goes.
│   Commands, questions, orchestration, conversation.
│   "spawn a worker", "status", "what do you think about X"
│   This is your terminal, but in Discord.
│
├── #notifications
│   Purpose: Read-only cross-cutting feed across all workers/projects.
│   One-liners: ✅ done, ❌ error, 📋 update, 🚫 blocked
│   Glanceable. No interaction needed.
│
├── #ml-training ◄──────────── PROJECT CHANNEL
│   [pinned] Context:
│     "Dataset: ImageNet-1k. Model: ResNet-50.
│      Goal: Beat 76% top-1 accuracy.
│      Cluster: aarusha@cluster.university.edu
│      Scratch dir: /scratch/aarusha/ml-training/
│      Current best: 74.2% (run-003)"
│
│   Discussion about this project goes here.
│   You + Claude discuss strategy, review results, plan next steps.
│
│   ├── Thread: gpu-train-004    (worker)
│   │   [pinned] Status: RUNNING | Epoch 35/50 | Loss 0.031
│   │   Worker updates, your directives, permission requests — all here.
│   │   Messages route DIRECTLY to the worker (no middleman).
│   │
│   ├── Thread: eval-pipeline    (worker)
│   │   [pinned] Status: IDLE | Waiting for gpu-train to finish
│   │
│   └── Thread: slurm-watch      (worker)
│       [pinned] Status: RUNNING | Checking every 15m
│
├── #api-refactor ◄──────────── PROJECT CHANNEL
│   [pinned] Context:
│     "Repo: ~/projects/api (branch: feat/jwt-auth)
│      Goal: Replace session cookies with JWT.
│      Blocked: waiting on DB migration (ticket API-234).
│      Test command: npm test -- --filter auth"
│
│   ├── Thread: refactor-auth    (worker)
│   └── Thread: test-runner      (worker)
│
└── #quick-tasks ◄──────────── DEFAULT (no project context)
    One-off workers that don't belong to a project.
    ├── Thread: download-dataset
    └── Thread: fix-typos
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    YOUR DISCORD SERVER                       │
│                                                             │
│  #main ─────────────── Talk to Claude (commands + chat)     │
│  #notifications ────── Read-only feed (all workers)         │
│  #ml-training ──────── Project channel (pinned context)     │
│    ├── Thread: gpu-train-004    (worker)                    │
│    ├── Thread: eval-pipeline    (worker)                    │
│    └── Thread: slurm-watch      (worker)                   │
│  #api-refactor ─────── Project channel (pinned context)     │
│    ├── Thread: refactor-auth    (worker)                    │
│    └── Thread: test-runner      (worker)                    │
│  #quick-tasks ──────── Default (no project, one-off work)   │
│    └── Thread: download-dataset                             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                         Discord API
                               │
┌──────────────────────────────┼──────────────────────────────┐
│  YOUR MAC (persistent, tmux)  │                              │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  CUSTOM CHANNEL: orchestrator-discord                │   │
│  │  (MCP server + discord.js bot)                       │   │
│  │                                                      │   │
│  │  Routing:                                            │   │
│  │   #main msg          → notify main session           │   │
│  │   #project msg       → notify main session           │   │
│  │     (not in thread)    (with project context)        │   │
│  │   #project thread    → DIRECT to worker              │   │
│  │     (worker thread)    (inbox + tmux, no middleman)  │   │
│  │   permission verdict → relay to Claude Code          │   │
│  │                                                      │   │
│  │  Tools for Claude:                                   │   │
│  │   reply, create_project_channel, create_worker_thread│   │
│  │   post_notification, update_status, update_context   │   │
│  │                                                      │   │
│  │  State (persisted to disk):                          │   │
│  │   projects: Map<channel_id, ProjectState>            │   │
│  │   workers: Map<thread_id, WorkerState>               │   │
│  │   allowedSenders: Set<user_id>                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                              │                              │
│                    stdio (MCP protocol)                     │
│                              │                              │
│  ┌───────────────────────────┼──────────────────────────┐   │
│  │  MAIN CLAUDE SESSION                                 │   │
│  │  claude --channels orchestrator-discord               │   │
│  │         --dangerously-load-development-channels       │   │
│  │                                                      │   │
│  │  Handles: #main messages, project discussion,        │   │
│  │    spawn/kill/status, cross-worker coordination      │   │
│  │  Does NOT handle: worker thread messages (direct)    │   │
│  └───────────────────┬──────────────────────────────┘   │   │
│                      │                                      │
│          tmux manages all workers                           │
│                      │                                      │
│      ┌───────────────┼───────────────┐                      │
│      ▼               ▼               ▼                      │
│  ┌────────┐    ┌──────────┐    ┌──────────┐                 │
│  │ tmux:  │    │ tmux:    │    │ tmux:    │                 │
│  │ orch-  │    │ orch-    │    │ orch-    │                 │
│  │ gpu-   │    │ slurm-   │    │ refactor │                 │
│  │ train  │    │ watch    │    │ -auth    │                 │
│  └───┬────┘    └────┬─────┘    └────┬─────┘                 │
│      ▼              ▼               ▼                       │
│   ssh to          ssh to          local                     │
│   cluster         cluster         code                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Communication Flows

### Routing Decision Tree

```
Discord message arrives
       │
       ▼
  Check sender against allowlist
       │
       ▼
  Where is this message?
       │
       ├── #main
       │   → mcp.notification() to main session
       │     meta: { channel: "main" }
       │     Main session responds via reply() tool
       │
       ├── Project channel (not in a thread)
       │   e.g., #ml-training top-level message
       │   → mcp.notification() to main session
       │     meta: { channel: "ml-training", project: true }
       │     Main session responds (project discussion)
       │
       ├── Project channel → Worker thread
       │   e.g., #ml-training → Thread: gpu-train-004
       │   → DIRECT ROUTING (no main session involved):
       │     1. Write to workers/gpu-train-004/inbox/NNN.md
       │     2. tmux send-keys -t orch-gpu-train-004 "Check inbox" Enter
       │     3. Reply in thread: "📨 Directive sent"
       │
       ├── #quick-tasks → Worker thread
       │   → Same as project worker thread (direct routing)
       │
       ├── Permission verdict ("yes abc12" / "no abc12")
       │   (detected anywhere by regex)
       │   → Emit permission notification to Claude Code
       │     React with ✅ or ❌
       │
       └── #notifications or unknown
           → Ignore
```

### Worker Thread — Direct Communication (No Middleman)

```
  YOU (phone)              CHANNEL SERVER              WORKER (tmux)
  ═══════════              ══════════════              ═════════════

  In #ml-training →
  Thread: gpu-train-004
  ┌─────────────────┐
  │ "also log the   │
  │  learning rate  │
  │  each epoch"    │     Discord event
  └─────────────────┘ ──────────────────►

                          Channel server sees:
                          - It's in a worker thread
                          - Thread maps to worker "gpu-train-004"
                          - DIRECT ROUTE (skip main session)

                          1. Write to inbox:
                             workers/gpu-train-004/inbox/003.md
                             "also log the learning rate each epoch"

                          2. tmux send-keys:               ┌─────────────┐
                             -t orch-gpu-train-004          │ Worker sees  │
                             "Check inbox for new    ─────► │ inbox nudge  │
                              directives" Enter             │ Reads 003.md │
                                                            │ Acts on it   │
                          3. Reply in thread:               └─────────────┘
                             "📨 Directive sent"

  You see:
  "📨 Directive sent"  ◄────
```

### Project Discussion — Via Main Session

```
  YOU (phone)              CHANNEL SERVER              MAIN SESSION
  ═══════════              ══════════════              ════════════

  In #ml-training
  (not in a thread):
  ┌──────────────────┐
  │ "should we try   │
  │  a larger batch  │
  │  size for the    │     Discord event
  │  next run?"      │ ──────────────────►
  └──────────────────┘
                          Channel server sees:
                          - It's in project channel, top-level
                          - Route to main session

                          mcp.notification({
                            content: "should we try...",
                            meta: {
                              channel: "ml-training",
                              project: "true",
                              sender: "aarusha"
                            }
                          })
                                                            │
                                                            ▼
                                                  Claude reads pinned context
                                                  for #ml-training project.
                                                  Knows: ResNet-50, ImageNet,
                                                  current best 74.2%

                                                  Responds via reply():
                                                  "Based on your current setup,
                                                   yes — ResNet-50 on ImageNet
                                                   typically benefits from batch
                                                   sizes of 256-512..."

  You see response
  in #ml-training   ◄──── Discord API ◄──────────
```

### Spawn from Discord

```
  YOU (in #main)           CHANNEL SERVER              MAIN SESSION
  ══════════════           ══════════════              ════════════

  "spawn a worker in
   #ml-training to run
   training run 005       Discord event
   with batch size 512"  ─────────────►  mcp.notification()
                                                   │
                                                   ▼
                                         Claude sees spawn request.
                                         Knows project context from
                                         #ml-training pinned message.

                                         1. orch spawn gpu-train-005 ~/ml \
                                            "Run training with batch size 512.
                                             Project context: ResNet-50, ImageNet,
                                             cluster: aarusha@cluster.edu,
                                             scratch: /scratch/aarusha/ml-training/"
                                            --ssh aarusha@cluster.edu
                                            --model sonnet

                                         2. create_worker_thread(
                                              project_channel: "ml-training",
                                              worker_name: "gpu-train-005"
                                            )

                                         3. update_status(
                                              "gpu-train-005",
                                              "running",
                                              "Batch size 512, ResNet-50"
                                            )

                                         4. reply(main, "Spawned gpu-train-005
                                            in #ml-training")

  #ml-training now has
  new thread:
  "gpu-train-005"
  with pinned status
```

### Worker Completion → Notifications

```
  WORKER                    CHANNEL SERVER              DISCORD
  ══════                    ══════════════              ═══════

  curl POST :9111/notify
  {worker: "gpu-train-005",
   event: "done",
   summary: "Top-1: 76.8%! ─────────────►
    New best. Model saved
    to /scratch/.../v5"}
                               Channel server handles DIRECTLY:

                               1. Post in worker thread:
                                  "✅ Done! Top-1: 76.8% ──► #ml-training →
                                   New best. Model saved      Thread: gpu-train-005
                                   to .../v5"

                               2. Post in #notifications:
                                  "✅ [gpu-train-005]    ──► #notifications
                                   Top-1: 76.8%! New best."

                               3. Update pinned status:
                                  Status: DONE | 76.8% top-1

                               4. Notify main session:
                                  mcp.notification() so Claude
                                  can update project context
                                  (new best: 76.8%)

                               5. Optional: iMessage ping
                                  "gpu-train-005 done: 76.8%!"
```

### Permission Relay (In Worker Thread)

```
  WORKER (gpu-train-005)            CHANNEL SERVER               DISCORD
  ══════════════════════            ══════════════               ═══════

  Wants to run:
  rm -rf /tmp/old-checkpoints
       │
       │ Claude Code sends
       │ permission_request
       ▼
  Channel receives:
  request_id: "abc12"
  tool_name: "Bash"                 Posts IN THE WORKER THREAD    #ml-training →
  description: "rm -rf ..."    ──►  (not a separate channel):    Thread: gpu-train-005
                                    "🔐 Wants to run: Bash       ┌──────────────────┐
                                     rm -rf /tmp/old-checkpoints │ 🔐 Bash: rm -rf  │
                                     Reply: yes abc12            │ yes abc12 /       │
                                     or: no abc12"               │ no abc12          │
                                                                 └────────┬─────────┘
                                                                          │
  You reply in same thread:                                               │
  "yes abc12"               ◄─────────────────────────────────────────────┘
       │
       ▼
  Channel parses verdict,
  emits permission notification.
  Worker proceeds.
  Reacts with ✅.
```

---

## Projects

### What Is a Project?

A project is a Discord channel with:
1. **Pinned context** — key facts that all workers in this project inherit
2. **Worker threads** — one per worker, spawned within the project
3. **Discussion** — top-level messages go to the main session with project context

### Project Context

The pinned message in a project channel is structured context that gets injected into every worker's system prompt when they spawn within that project:

```markdown
## Project: ml-training

**Goal:** Beat 76% top-1 accuracy on ImageNet with ResNet-50
**Cluster:** aarusha@cluster.university.edu
**Scratch:** /scratch/aarusha/ml-training/
**Local dir:** ~/ml/
**Current best:** 76.8% (run-005, batch size 512)
**Key decisions:**
- Using SGD with cosine annealing (Adam was worse, run-002)
- Data augmentation: RandAugment N=2 M=9
**History:**
- run-003: 74.2% (baseline, batch 128)
- run-004: 75.1% (batch 256)
- run-005: 76.8% (batch 512) ← current best
```

When a worker spawns in this project, its system prompt includes:

```
## Project Context (from #ml-training)
[the pinned context above]

## Your Task
[the specific prompt for this worker]
```

### Context Updates

Context gets updated when:
1. **You edit the pinned message** manually in Discord
2. **Claude updates it** via the `update_context` tool after a worker reports results
3. **You tell Claude** in #main or #ml-training to update the context

```
Worker reports: "Run 005 achieved 76.8%"
    │
    ▼
Main session sees notification.
Calls: update_context("ml-training", {
  add to history: "run-005: 76.8% (batch 512)",
  update current_best: "76.8% (run-005, batch size 512)"
})
    │
    ▼
Channel server edits the pinned message in #ml-training.
Future workers spawned here get the updated context.
```

### Project Lifecycle

```
orch project create <name> <context>
  → Creates Discord channel #<name>
  → Pins context message
  → Registers in state

orch project update <name> <new-context>
  → Edits pinned message
  → Future workers get new context

orch project archive <name>
  → Archives the Discord channel
  → Moves workers to done state

orch project list
  → Lists all projects with worker counts and status
```

---

## File Layout

```
~/.claude-orchestrator/
├── bin/
│   └── orch                          # CLI: spawn, send, kill, status, list, project, cleanup
│
├── channel/                          # Custom Discord channel (MCP server)
│   ├── package.json                  # deps: @modelcontextprotocol/sdk, discord.js, zod
│   ├── server.ts                     # Entry: MCP server + Discord bot + HTTP listener
│   ├── routing.ts                    # Discord msg → route decision (main/project/worker/verdict)
│   ├── tools.ts                      # MCP tools exposed to Claude
│   ├── state.ts                      # Persisted state: projects, workers, senders
│   ├── permissions.ts                # Permission relay logic
│   ├── direct.ts                     # Direct worker routing (inbox write + tmux nudge)
│   ├── .env                          # DISCORD_BOT_TOKEN, GUILD_ID
│   └── node_modules/
│
├── templates/                        # System prompt templates
│   ├── default.md                    # Base worker instructions
│   ├── slurm-monitor.md              # SLURM job monitoring specialist
│   ├── ssh-worker.md                 # Generic SSH remote work
│   └── code-worker.md                # Local code modification
│
├── hooks/
│   └── notify-main.sh               # PostToolUse hook: heartbeat + inbox check
│
├── workers/                          # Runtime state per worker
│   ├── gpu-train-005/
│   │   ├── meta.json                 # {name, project, created, dir, prompt, ssh_host,
│   │   │                             #  pid, tmux_session, discord_thread_id}
│   │   ├── status                    # running | idle | done | error
│   │   ├── task                      # Current task description
│   │   ├── project-context.md        # Snapshot of project context at spawn time
│   │   ├── inbox/                    # Directives from you (via Discord or orch send)
│   │   └── outbox/                   # Updates from worker (via curl to :9111)
│   └── ...
│
├── projects/                         # Project metadata (mirrors Discord state)
│   ├── ml-training.json              # {channel_id, context_message_id, created, status}
│   └── api-refactor.json
│
└── config.json
    # {
    #   "channel_port": 9111,
    #   "default_model": "sonnet",
    #   "max_workers": 12,
    #   "discord": {
    #     "guild_id": "...",
    #     "main_channel_id": "...",
    #     "notifications_channel_id": "...",
    #     "quick_tasks_channel_id": "..."
    #   },
    #   "imessage": {
    #     "enabled": true,
    #     "notify_events": ["done", "error"]
    #   }
    # }
```

---

## Component Design

### 1. `orch` CLI (Bash)

```
WORKER COMMANDS:
  orch spawn <name> <dir> <prompt> [options]
    --ssh <user@host>          SSH into this host
    --project <name>           Attach to project (inherits context)
    --template <name>          System prompt template (default: "default")
    --model <model>            Model (default: config.default_model)
    --no-permissions-skip      Require permission approvals

  orch send <name> <message>   Write to inbox + tmux nudge
  orch status [name]           Show worker(s) status
  orch logs <name> [--tail N]  Capture tmux pane output
  orch kill <name>             Graceful shutdown
  orch list                    Table of all workers
  orch cleanup                 Remove done workers >24h

PROJECT COMMANDS:
  orch project create <name> <context>    Create Discord channel + pin context
  orch project update <name> <context>    Edit pinned context
  orch project archive <name>             Archive channel
  orch project list                       List projects
```

### 2. Custom Discord Channel (MCP Server)

Single process: discord.js bot + MCP channel + HTTP listener.

#### Tools Exposed to Claude

```typescript
// Reply to a Discord channel or thread
reply(channel_or_thread_id: string, text: string)

// Create a new project channel with pinned context
create_project_channel(name: string, context: string): { channel_id: string }

// Create a worker thread within a project channel (or #quick-tasks)
create_worker_thread(
  channel_id: string,    // project channel or #quick-tasks
  worker_name: string
): { thread_id: string }

// Post to #notifications
post_notification(text: string, severity: "success" | "error" | "update" | "blocked")

// Update the pinned status message in a worker's thread
update_status(worker_name: string, status: string, summary: string)

// Update the pinned project context message
update_context(project_name: string, new_context: string)

// Add a reaction
add_reaction(message_id: string, emoji: string)
```

#### Channel Instructions (system prompt)

```
You are connected to a Discord server via the orchestrator-discord channel.

## Routing
Messages arrive as <channel> tags:
- channel="main": You're being spoken to directly. Respond freely.
- channel="<project-name>" project="true": Project discussion.
  You have the project's pinned context. Respond with project awareness.
- source="worker" worker="<name>" event="<type>": Worker notification.
  Post to Discord (notification + worker thread + update status).
  If event="done", consider updating project context with results.

Worker thread messages are handled DIRECTLY by the channel server.
They do NOT come to you. You only hear about workers when they POST
updates via HTTP, or when someone messages you in #main or a project
channel top-level.

## Spawning Workers
When asked to spawn a worker:
1. Determine which project it belongs to (or #quick-tasks)
2. Run: orch spawn <name> <dir> <prompt> --project <project>
3. Call create_worker_thread(channel_id, worker_name)
4. Call update_status(worker_name, "running", summary)
5. Reply to confirm

## Managing Projects
When asked to create a project:
1. Call create_project_channel(name, context)
2. Confirm with channel link

When a worker reports results that change project state:
1. Call update_context with the new information
2. Inform the user
```

#### State

```typescript
interface ChannelState {
  // Fixed channel IDs
  mainChannelId: string
  notificationsChannelId: string
  quickTasksChannelId: string

  // Projects: channel_id → project info
  projects: Map<string, {
    name: string
    channelId: string
    contextMessageId: string     // pinned message to edit
    context: string              // cached context text
  }>

  // Workers: thread_id → worker info (for direct routing)
  workers: Map<string, {
    name: string
    projectName: string | null   // null = quick-task
    threadId: string
    statusMessageId: string
  }>

  // Pending permission requests
  pendingPermissions: Map<string, {
    requestId: string
    threadId: string             // post verdict in worker thread
    workerName: string
  }>

  // Access control
  allowedSenders: Set<string>
}
```

### 3. Worker System Prompt Template (default.md)

```markdown
You are a worker agent managed by the Claude Code Orchestrator.

## Your Identity
- Worker name: {{WORKER_NAME}}
- Working directory: {{WORKER_DIR}}
- SSH target: {{SSH_HOST}} (if applicable)
- Project: {{PROJECT_NAME}} (if applicable)

{{#if PROJECT_CONTEXT}}
## Project Context
{{PROJECT_CONTEXT}}
{{/if}}

## Communication Protocol
1. **Check inbox**: Before starting and periodically, read files in
   ~/.claude-orchestrator/workers/{{WORKER_NAME}}/inbox/ for new directives.
   Process them in order and delete after reading.

2. **Post updates** on significant milestones:
   curl -s -X POST http://localhost:9111/notify \
     -H "Content-Type: application/json" \
     -d '{"worker":"{{WORKER_NAME}}","event":"update","summary":"<what happened>"}'

3. **Signal completion** when fully done:
   curl -s -X POST http://localhost:9111/notify \
     -H "Content-Type: application/json" \
     -d '{"worker":"{{WORKER_NAME}}","event":"done","summary":"<final summary>"}'
   Then write "done" to ~/.claude-orchestrator/workers/{{WORKER_NAME}}/status

4. **Signal errors** or **blocked** if you need help:
   curl POST with event:"error" or event:"blocked" and what went wrong / what you need.

## Rules
- Work autonomously. Do not ask for confirmation on tool use.
- Stay focused on your assigned task and any inbox directives.
- Write concise summaries, not full logs, in your notifications.
- If SSH'd into a remote host, keep the connection alive.
- Post an update at least every 15 minutes if actively working.
```

### 4. Worker Hook: `notify-main.sh`

```bash
#!/bin/bash
WORKER_NAME="$CLAUDE_SESSION_NAME"
WORKER_DIR="$HOME/.claude-orchestrator/workers/$WORKER_NAME"

# Heartbeat
date +%s > "$WORKER_DIR/heartbeat"

# Inbox check
INBOX_COUNT=$(ls "$WORKER_DIR/inbox/" 2>/dev/null | wc -l)
if [ "$INBOX_COUNT" -gt 0 ]; then
  echo '{"message": "You have unread directives in your inbox. Check them now."}' >&2
fi
```

---

## Worker Lifecycle

```
  Spawn request (from #main or locally)
       │
       ▼
  1. CREATE STATE
     mkdir workers/<name>/
     Write meta.json, status, task, inbox/, outbox/
     If project: copy project context → project-context.md
       │
       ▼
  2. RENDER SYSTEM PROMPT
     template + worker name + project context
       │
       ▼
  3. CREATE DISCORD THREAD
     In project channel (or #quick-tasks)
     Pin status message
       │
       ▼
  4. LAUNCH TMUX
     tmux new-session -d -s orch-<name>
     claude --name <name> --system-prompt <rendered>
       --dangerously-skip-permissions --model <model>
       │
       ▼
  5. INJECT PROMPT
     tmux send-keys "<prompt>" Enter
     status → "running"
       │
       ▼
  6. AUTONOMOUS EXECUTION
     Worker runs, checks inbox, posts updates via curl
     Channel server routes Discord thread msgs directly
       │
       ├── Directive from Discord thread → inbox + tmux nudge
       ├── Directive from orch send → inbox + tmux nudge
       ├── Worker posts update → Discord thread + #notifications
       └── Worker done → Discord thread + #notifications + status
                         + main session notified (to update project context)
```

---

## iMessage Integration (Optional)

Lightweight pings only. No routing, no projects.

```bash
claude --channels orchestrator-discord \
       plugin:imessage@claude-plugins-official \
       --dangerously-load-development-channels
```

When workers report "done" or "error", the main session also sends an iMessage:
"gpu-train-005 done: 76.8% top-1, new best"

Good for Apple Watch notifications when you're AFK.

---

## Security

| Concern | Mitigation |
|---------|------------|
| `--dangerously-skip-permissions` on workers | Trusted dirs only. Or use permission relay via worker thread. |
| Discord bot token | In `.env`, not committed. |
| Prompt injection via Discord | Sender allowlist. Only paired users. |
| HTTP listener | 127.0.0.1:9111 only. |
| Project context as injection vector | Context is authored by you. Workers receive it as system prompt. |
| Discord server visibility | Private server or restricted channel permissions. |

---

## Prerequisites

```bash
brew install tmux
brew install node          # or bun
# Discord: create app, bot, server, invite bot
# Create channels: #main, #notifications, #quick-tasks
# Project channels created dynamically via orch project create

claude 2.1.83              # already available
```

---

## Discord Bot Permissions

```
OAuth2 scopes: bot, applications.commands
Bot permissions:
  - View Channels
  - Send Messages
  - Send Messages in Threads
  - Create Public Threads
  - Manage Threads
  - Manage Channels           ← NEW: for creating project channels
  - Read Message History
  - Attach Files
  - Add Reactions
  - Embed Links

Privileged Gateway Intent:
  - Message Content Intent
```

---

## Example Workflows

### Create a project and spawn workers from your phone

```
You in #main:
  "create a project for my ML training work. I'm training
   ResNet-50 on ImageNet on aarusha@cluster.edu, scratch dir
   is /scratch/aarusha/ml-training/, local dir ~/ml/"

Bot creates #ml-training, pins context. Replies:
  "✅ Created #ml-training with context pinned."

You in #main:
  "spawn a worker in #ml-training to start run 005
   with batch size 512"

Bot creates thread in #ml-training, spawns worker. Replies:
  "✅ Spawned gpu-train-005 in #ml-training"
```

### Talk to a worker directly

```
You in #ml-training → Thread: gpu-train-005:
  "also log learning rate each epoch to a CSV"

Bot: "📨 Directive sent"

(later)
Bot: "📋 Now logging LR to ~/ml/lr-log.csv each epoch"
```

### Project discussion (not worker-specific)

```
You in #ml-training (not in a thread):
  "the last 3 runs plateaued around 75%. should we try
   a different optimizer?"

Bot (Claude, with project context):
  "Looking at your history — runs 003-005 all used SGD with
   cosine annealing. A few things to try:
   1. AdamW with weight decay 0.05 (works well for ResNet)
   2. LARS optimizer for large batch sizes
   3. Warmup + cosine might help if you increase batch to 1024
   Want me to spawn a worker to try AdamW?"
```

### Worker finishes, project context auto-updates

```
Bot in #ml-training → Thread: gpu-train-005:
  "✅ Done! Top-1: 76.8%. New best. Model at /scratch/.../v5"

Bot in #notifications:
  "✅ [gpu-train-005] 76.8% top-1. New best."

Bot edits pinned context in #ml-training:
  Current best: 76.8% (run-005, batch size 512) ← auto-updated
  History: + run-005: 76.8% (batch 512) ← auto-appended

Your Apple Watch: "gpu-train-005 done: 76.8%!"
```

### Check everything at a glance

```
You in #main:
  "status"

Bot:
  "PROJECTS:
   #ml-training — 2 workers (1 running, 1 done)
   #api-refactor — 1 worker (running)

   WORKERS:
   ┌──────────────────┬──────────────┬─────────┬────────┬─────────────────┐
   │ Worker           │ Project      │ Status  │ Uptime │ Last Update     │
   ├──────────────────┼──────────────┼─────────┼────────┼─────────────────┤
   │ gpu-train-005    │ ml-training  │ done    │ 4h 10m │ 76.8% top-1    │
   │ slurm-watch      │ ml-training  │ running │ 6h 30m │ Job RUNNING     │
   │ refactor-auth    │ api-refactor │ running │ 1h 15m │ 3/7 files done  │
   └──────────────────┴──────────────┴─────────┴────────┴─────────────────┘"
```

---

## Implementation Plan

### Phase 1: Foundation (local only, no Discord)
1. Install tmux
2. Create `~/.claude-orchestrator/` directory structure
3. Write `orch` CLI with spawn, send, status, list, kill, logs, cleanup
4. Write default.md system prompt template
5. Test: spawn worker, send directive, check status, kill

### Phase 2: Discord Channel (basic)
6. Create Discord bot + server with #main, #notifications, #quick-tasks
7. Build channel MCP server: Discord connection + MCP stdio + HTTP listener
8. Implement routing: #main → main session, worker thread → direct
9. Implement tools: reply, create_worker_thread, post_notification, update_status
10. Register channel, test with --dangerously-load-development-channels
11. End-to-end: spawn from #main, worker runs, updates in thread, completes

### Phase 3: Projects
12. Add orch project create/update/archive/list
13. Implement create_project_channel and update_context tools
14. Project context injection into worker system prompts
15. Auto-update context when workers report results
16. Test: create project, spawn workers in it, context flows through

### Phase 4: Polish
17. Permission relay in worker threads
18. State persistence + recovery on restart
19. iMessage integration for pings
20. Heartbeat monitoring (detect dead workers)
21. Discord rate limit debouncing
22. Rich embeds for status messages
23. Test with 4+ concurrent workers across 2+ projects

---

## Open Questions

1. **Channel auth** — Custom channels need `--dangerously-load-development-channels` during research preview. Fine for personal use.

2. **Worker model selection** — `haiku` for monitoring, `sonnet` for code, `opus` for complex. Configurable per-spawn.

3. **Worker-to-worker communication** — Not in v1. Workers could share an inbox, or a project-level shared state file. Deferred.

4. **Remote tmux** — Running tmux on the remote server for full persistence. Deferred to v2.

5. **Discord rate limits** — ~50 req/10s per channel. Channel server should debounce with 8+ workers.

6. **State recovery** — Channel server state must persist to disk and reload on restart.

7. **Project context size** — Discord pins have a 2000 char limit for messages. For larger context, could use multiple pinned messages or a file-based approach with a summary pinned.
