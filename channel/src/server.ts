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

const INSTRUCTIONS = `You have access to orchestrator tools from the orchestrator-companion server.
These let you manage worker Discord threads, project channels, and status messages.

For conversational replies to Discord users, use the official Discord plugin's reply tool.
For orchestrator actions, use these tools:

- create_worker_thread(channel_id, worker_name): Create a Discord thread for a worker with pinned status
- update_status(worker_name, status, summary): Edit the pinned status message in a worker's thread
- post_notification(text, severity): Post to #notifications channel
- create_project_channel(name, context): Create a new Discord channel for a project with pinned context
- update_context(project_name, new_context): Edit pinned context in a project channel
- route_to_worker(worker_name, message): Forward a message directly to a worker's inbox

Worker notifications from HTTP POST to :9111 arrive as <channel source="orchestrator-companion" ...> tags.
- source="worker" worker="<name>" event="done|update|error|blocked": Worker posted an update.
  When event="done", consider updating the project context with results.
  When event="error" or event="blocked", inform the user.

## Memory System
The orchestrator has a persistent memory system at ~/.claude-orchestrator/memory/.
Before responding to a user request, check the memory indexes:
- User memory: ~/.claude-orchestrator/memory/user/_index.md (SSH configs, preferences, implicit mappings)
- Project memory: ~/.claude-orchestrator/projects/<name>/memory/_index.md
Read full memory files when you need details beyond the index summary.

When you learn something implicit about the user's workflow — like "check status" means
SSH into a specific server, or they always want a certain model for a certain task type,
or a project lives on a specific remote host — save it as a memory using:
  orch memory add user <id> "<title>" --category preference
  (or --category procedure, environment, etc.)
Then edit the file at ~/.claude-orchestrator/memory/user/<id>.md to add full details.
Run: orch memory rebuild --user

Do this sparingly — only for non-obvious mappings the user would have to explain again.

When spawning a worker:
1. Choose the right model and template based on the task:
   - Monitoring/polling tasks: --template slurm-monitor (defaults to haiku)
   - Code refactoring/implementation: --template code-worker (defaults to opus)
   - SSH remote work: --template ssh-worker (defaults to sonnet)
   - Complex multi-step reasoning: --model opus (override any template)
   - Simple one-off tasks: --model haiku
   You can always override with --model <model> regardless of template.
2. Run: orch spawn <name> <dir> <prompt> [--project <project>] [--template <tpl>] [--model <model>]
3. Call create_worker_thread(channel_id, worker_name)
4. Call update_status(worker_name, "RUNNING", summary)
5. Reply to confirm using the Discord plugin's reply tool

When someone messages in a worker thread (you'll see the chat_id matches a known worker thread):
1. Do NOT respond conversationally
2. Call route_to_worker(worker_name, message_content)
3. Reply "📨 Directive sent" using the Discord plugin's reply tool`

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
