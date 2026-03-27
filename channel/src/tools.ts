import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as discord from './discord-rest.js'
import type { ChannelState } from './state.js'
import { addWorker, addProject, saveState } from './state.js'
import { routeToWorker } from './direct.js'

const SEVERITY_EMOJI: Record<string, string> = {
  success: '\u2705',
  error: '\u274C',
  update: '\uD83D\uDCCB',
  blocked: '\uD83D\uDEAB',
}

export function registerTools(mcp: Server, state: ChannelState): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'post_notification',
        description: 'Post a notification to the #notifications channel with a severity indicator',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The notification text' },
            severity: {
              type: 'string',
              enum: ['success', 'error', 'update', 'blocked'],
              description: 'Severity level for the emoji prefix',
            },
          },
          required: ['text', 'severity'],
        },
      },
      {
        name: 'create_worker_thread',
        description: 'Create a new thread in a channel for a worker, with a pinned status message',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'The parent channel ID (project channel or #tasks)' },
            worker_name: { type: 'string', description: 'Name of the worker' },
          },
          required: ['channel_id', 'worker_name'],
        },
      },
      {
        name: 'update_status',
        description: "Update the pinned status message in a worker's thread",
        inputSchema: {
          type: 'object',
          properties: {
            worker_name: { type: 'string', description: 'Name of the worker' },
            status: { type: 'string', description: 'Current status (e.g., RUNNING, DONE, ERROR)' },
            summary: { type: 'string', description: 'Brief status summary' },
          },
          required: ['worker_name', 'status', 'summary'],
        },
      },
      {
        name: 'update_context',
        description: 'Update the pinned context message in a project channel',
        inputSchema: {
          type: 'object',
          properties: {
            project_name: { type: 'string', description: 'Name of the project' },
            new_context: { type: 'string', description: 'New context text to replace the pinned message content' },
          },
          required: ['project_name', 'new_context'],
        },
      },
      {
        name: 'create_project_channel',
        description: 'Create a new Discord channel for a project with pinned context',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name (used as channel name)' },
            context: { type: 'string', description: 'Project context to pin in the channel' },
          },
          required: ['name', 'context'],
        },
      },
      {
        name: 'route_to_worker',
        description: 'Forward a message directly to a worker\'s inbox and nudge via tmux. Use when a Discord message is from a worker thread.',
        inputSchema: {
          type: 'object',
          properties: {
            worker_name: { type: 'string', description: 'Name of the worker to route to' },
            message: { type: 'string', description: 'The message content to deliver' },
          },
          required: ['worker_name', 'message'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const a = args as Record<string, string>

    try {
      switch (name) {
        case 'post_notification':
          return await handlePostNotification(state, a.text, a.severity)
        case 'create_worker_thread':
          return await handleCreateWorkerThread(state, a.channel_id, a.worker_name)
        case 'update_status':
          return await handleUpdateStatus(state, a.worker_name, a.status, a.summary)
        case 'update_context':
          return await handleUpdateContext(state, a.project_name, a.new_context)
        case 'create_project_channel':
          return await handleCreateProjectChannel(state, a.name, a.context)
        case 'route_to_worker':
          return handleRouteToWorker(a.worker_name, a.message)
        default:
          throw new Error(`Unknown tool: ${name}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `${name} failed: ${msg}` }], isError: true }
    }
  })
}

// --- Tool implementations ---

async function handlePostNotification(state: ChannelState, text: string, severity: string) {
  const channelId = process.env.NOTIFICATIONS_CHANNEL_ID || state.notificationsChannelId
  if (!channelId) {
    return { content: [{ type: 'text' as const, text: 'notifications channel not configured' }] }
  }
  const emoji = SEVERITY_EMOJI[severity] || '\uD83D\uDCCB'
  const msg = await discord.sendMessage(channelId, `${emoji} ${text}`)
  return { content: [{ type: 'text' as const, text: `posted (message_id: ${msg.id})` }] }
}

async function handleCreateWorkerThread(state: ChannelState, channelId: string, workerName: string) {
  const thread = await discord.createThread(channelId, workerName)
  const statusMsg = await discord.sendMessage(thread.id, `**Status:** STARTING | Worker initializing...`)
  await discord.pinMessage(thread.id, statusMsg.id)

  const projectInfo = Object.values(state.projects).find(p => p.channelId === channelId)
  addWorker(state, {
    name: workerName,
    projectName: projectInfo?.name || null,
    threadId: thread.id,
    statusMessageId: statusMsg.id,
  })

  return {
    content: [{
      type: 'text' as const,
      text: `Thread created (thread_id: ${thread.id}, status_message_id: ${statusMsg.id})`
    }]
  }
}

async function handleUpdateStatus(state: ChannelState, workerName: string, status: string, summary: string) {
  const worker = state.workers[workerName]
  if (!worker) {
    return { content: [{ type: 'text' as const, text: `Worker ${workerName} not found in state` }] }
  }
  await discord.editMessage(worker.threadId, worker.statusMessageId, `**Status:** ${status.toUpperCase()} | ${summary}`)
  return { content: [{ type: 'text' as const, text: 'status updated' }] }
}

async function handleUpdateContext(state: ChannelState, projectName: string, newContext: string) {
  const project = state.projects[projectName]
  if (!project) {
    return { content: [{ type: 'text' as const, text: `Project ${projectName} not found in state` }] }
  }
  await discord.editMessage(project.channelId, project.contextMessageId, newContext)
  project.context = newContext
  saveState(state)
  return { content: [{ type: 'text' as const, text: 'context updated' }] }
}

async function handleCreateProjectChannel(state: ChannelState, name: string, context: string) {
  const guildId = process.env.GUILD_ID
  if (!guildId) {
    return { content: [{ type: 'text' as const, text: 'GUILD_ID not configured' }] }
  }
  const channel = await discord.createGuildChannel(guildId, name)
  const contextMsg = await discord.sendMessage(channel.id, context)
  await discord.pinMessage(channel.id, contextMsg.id)

  addProject(state, {
    name,
    channelId: channel.id,
    contextMessageId: contextMsg.id,
    context,
  })

  return {
    content: [{
      type: 'text' as const,
      text: `Project channel created (channel_id: ${channel.id}, context_message_id: ${contextMsg.id})`
    }]
  }
}

function handleRouteToWorker(workerName: string, message: string) {
  routeToWorker(workerName, message)
  return { content: [{ type: 'text' as const, text: `Directive delivered to ${workerName} inbox` }] }
}
