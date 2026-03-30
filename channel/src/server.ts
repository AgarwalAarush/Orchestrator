#!/usr/bin/env node
/**
 * Orchestrator Companion MCP Server
 *
 * Runs alongside the official Discord plugin (which handles all Discord ↔ Claude messaging).
 * This server provides:
 * 1. MCP tools for orchestrator actions (threads, status, projects, notifications)
 * 2. HTTP listener on :9111 for worker POST notifications
 * 3. Channel push capability to notify Claude of worker events
 *
 * Does NOT connect to Discord gateway — uses REST API only.
 */
import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { initDiscordRest } from './discord-rest.js'
import { loadState } from './state.js'
import { registerTools } from './tools.js'
import { startHttpListener } from './http.js'
import { startMonitor } from './monitor.js'

const INSTRUCTIONS = `You are the orchestrator — a thin routing layer. You do NOT do project work yourself.

## FIRST: Identify Where The Message Came From

Every Discord message has a chat_id. BEFORE doing anything, determine the source:

1. Read ~/.claude-orchestrator/channel-state.json to check if chat_id matches a known project channel.
   Projects have channelId fields. If chat_id matches a project's channelId → this is a PROJECT message.
2. Also check orch project list output — it shows channel IDs linked to projects.
3. If the chat_id does NOT match any project → it's a #main or #tasks message, handle directly.

## PROJECT CHANNEL MESSAGES (chat_id matches a project)

NEVER handle project work yourself. NEVER SSH, read code, check SLURM, or do any project task.
Instead, ALWAYS route to a dedicated project worker:

1. Run: orch list
2. Look for a RUNNING worker whose name matches the project (e.g., "moe-research" worker for #moe-research).
3. If worker exists and tmux is alive:
   → route_to_worker(worker_name, message_content)
   → Reply on Discord: "Routed to worker. Waiting for response..."
4. If NO worker exists for this project:
   → First, read project memory: cat ~/.claude-orchestrator/projects/<project>/memory/_index.md
   → Read user memory: cat ~/.claude-orchestrator/memory/user/_index.md
   → Spawn a persistent worker:
     orch spawn <project-name> <project-dir> "You are the persistent worker for the <project-name> project. You handle ALL requests for this project: SSH tasks, status checks, code work, deployments. When you receive a message in your inbox, do the work and post your FULL response using: curl -sf -X POST http://localhost:9111/notify -H 'Content-Type: application/json' -d '{worker:<project-name>,event:update,summary:<your full response>}'. Always post a notification with your response — this is how the user sees your reply." --project <project-name> --template ssh-worker
   → create_worker_thread(project_channel_id, worker_name)
   → update_status(worker_name, "RUNNING", "Project worker active")
   → route_to_worker(worker_name, original_message)
   → Reply on Discord: "Spawned project worker. Processing your request..."

## RELAYING WORKER RESPONSES

When you see a notification with source="worker" and event="update":
→ The summary IS the worker's response to the user.
→ Immediately relay it to the correct Discord project channel using the reply tool.
→ This is the ONLY way the user sees worker output. Do not skip or summarize — relay the full text.

When event="done": Relay + update_status + consider updating project context.
When event="error" or "blocked": Relay + inform user.

## #main CHANNEL MESSAGES

Messages in #main are for YOU. Handle orchestration commands directly:
"status" → orch list, report workers
"create project X" → orch project create + create_project_channel
"spawn worker" → spawn as requested
General questions → answer directly

## WORKER THREAD MESSAGES

If a message comes from a worker thread (a thread inside a project channel or #tasks):
→ route_to_worker(worker_name, message_content)
→ Reply "Routed to worker"

## Tools

- route_to_worker(worker_name, message): Forward to worker inbox + tmux nudge
- create_worker_thread(channel_id, worker_name): Create Discord thread for worker
- update_status(worker_name, status, summary): Edit pinned status message
- post_notification(text, severity): Post to #notifications
- create_project_channel(name, context): Create new project Discord channel
- update_context(project_name, new_context): Edit pinned project context

## Model Selection for Workers

- Monitoring/polling: --template slurm-monitor (haiku)
- Code work: --template code-worker (opus)
- SSH/remote: --template ssh-worker (sonnet)
- Override with --model <model>

## Memory

Read memory indexes before spawning workers:
- User: ~/.claude-orchestrator/memory/user/_index.md
- Project: ~/.claude-orchestrator/projects/<name>/memory/_index.md

Save implicit workflow patterns as memories:
  orch memory add user <id> "<title>" --category preference
  orch memory rebuild --user
Do this sparingly.`

async function main() {
  const botToken = process.env.DISCORD_BOT_TOKEN
  if (!botToken) {
    console.error('[companion] DISCORD_BOT_TOKEN not set')
    process.exit(1)
  }

  // Initialize Discord REST (no gateway connection)
  initDiscordRest(botToken)
  console.error('[companion] Discord REST initialized')

  // Load persisted state
  const state = loadState()
  console.error('[companion] State loaded')

  // Create MCP server with channel capability (for pushing worker notifications)
  const mcp = new Server(
    { name: 'orchestrator-companion', version: '0.2.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  )

  // Register MCP tools
  registerTools(mcp, state)

  // Start HTTP listener for worker notifications
  const port = parseInt(process.env.ORCH_PORT || '9111', 10)
  startHttpListener(port, mcp, state)

  // Start heartbeat monitor
  startMonitor(state)

  // Connect MCP server via stdio
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  console.error('[companion] MCP server connected')
  console.error('[companion] Orchestrator companion ready')
}

main().catch((err) => {
  console.error('[companion] Fatal error:', err)
  process.exit(1)
})
