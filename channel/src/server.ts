#!/usr/bin/env node
import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { loadState } from './state.js'
import { registerTools } from './tools.js'
import { routeMessage } from './routing.js'
import { registerPermissionHandler } from './permissions.js'
import { startHttpListener } from './http.js'

const CHANNEL_INSTRUCTIONS = `You are connected to a Discord server via the orchestrator-discord channel.

## Routing
Messages arrive as <channel> tags:
- channel="main": You're being spoken to directly. Respond via the reply tool, using the message's channel ID.
- channel="<project-name>" project="true": Project discussion. You have the project's pinned context. Respond with project awareness via the reply tool.
- source="worker" worker="<name>" event="<type>": Worker notification. Post to Discord (notification + worker thread + update status). If event="done", consider updating project context with results.

Worker thread messages are handled DIRECTLY by the channel server. They do NOT come to you. You only hear about workers when they POST updates via HTTP, or when someone messages you in #main or a project channel top-level.

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
2. Inform the user`

async function main() {
  // Validate environment
  const botToken = process.env.DISCORD_BOT_TOKEN
  if (!botToken) {
    console.error('[server] DISCORD_BOT_TOKEN not set. Create a .env file from .env.example')
    process.exit(1)
  }

  // Load persisted state
  const state = loadState()
  console.error('[server] State loaded')

  // Create MCP server
  const mcp = new Server(
    { name: 'orchestrator-discord', version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions: CHANNEL_INSTRUCTIONS,
    }
  )

  // Create Discord client
  const discord = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  })

  // Register MCP tools
  registerTools(mcp, discord, state)

  // Register permission handler
  registerPermissionHandler(mcp, discord, state)

  // Discord: handle incoming messages
  discord.on('messageCreate', async (message) => {
    try {
      await routeMessage(message, mcp, discord, state)
    } catch (err) {
      console.error('[server] Error routing message:', err)
    }
  })

  // Discord: log when ready
  discord.once('ready', (client) => {
    console.error(`[server] Discord bot logged in as ${client.user.tag}`)
  })

  // Connect Discord
  await discord.login(botToken)

  // Start HTTP listener for worker notifications
  const port = parseInt(process.env.ORCH_PORT || '9111', 10)
  startHttpListener(port, mcp, discord, state)

  // Connect MCP server via stdio
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  console.error('[server] MCP server connected via stdio')
  console.error('[server] Orchestrator channel ready')
}

main().catch((err) => {
  console.error('[server] Fatal error:', err)
  process.exit(1)
})
