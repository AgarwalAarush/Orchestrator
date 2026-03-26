import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  Client, TextChannel, ThreadChannel, ChannelType,
  type GuildChannelCreateOptions,
} from 'discord.js'
import type { ChannelState } from './state.js'
import { addWorker, addProject, saveState } from './state.js'

const SEVERITY_EMOJI: Record<string, string> = {
  success: '✅',
  error: '❌',
  update: '📋',
  blocked: '🚫',
}

export function registerTools(
  mcp: Server,
  discord: Client,
  state: ChannelState
): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Send a message to a Discord channel or thread',
        inputSchema: {
          type: 'object',
          properties: {
            channel_or_thread_id: { type: 'string', description: 'The Discord channel or thread ID to send to' },
            text: { type: 'string', description: 'The message text to send' },
          },
          required: ['channel_or_thread_id', 'text'],
        },
      },
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
        description: 'Update the pinned status message in a worker\'s thread',
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
        name: 'add_reaction',
        description: 'Add a reaction emoji to a Discord message',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'The channel containing the message' },
            message_id: { type: 'string', description: 'The message ID to react to' },
            emoji: { type: 'string', description: 'The emoji to add (e.g., "✅", "👍")' },
          },
          required: ['channel_id', 'message_id', 'emoji'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const a = args as Record<string, string>

    switch (name) {
      case 'reply':
        return await handleReply(discord, a.channel_or_thread_id, a.text)

      case 'post_notification':
        return await handlePostNotification(discord, state, a.text, a.severity)

      case 'create_worker_thread':
        return await handleCreateWorkerThread(discord, state, a.channel_id, a.worker_name)

      case 'update_status':
        return await handleUpdateStatus(discord, state, a.worker_name, a.status, a.summary)

      case 'update_context':
        return await handleUpdateContext(discord, state, a.project_name, a.new_context)

      case 'create_project_channel':
        return await handleCreateProjectChannel(discord, state, a.name, a.context)

      case 'add_reaction':
        return await handleAddReaction(discord, a.channel_id, a.message_id, a.emoji)

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  })
}

// --- Tool implementations ---

async function handleReply(discord: Client, channelOrThreadId: string, text: string) {
  const channel = await discord.channels.fetch(channelOrThreadId)
  if (!channel?.isTextBased()) {
    return { content: [{ type: 'text' as const, text: `Channel ${channelOrThreadId} not found or not text-based` }] }
  }
  const msg = await (channel as TextChannel).send(text)
  return { content: [{ type: 'text' as const, text: `sent (message_id: ${msg.id})` }] }
}

async function handlePostNotification(
  discord: Client,
  state: ChannelState,
  text: string,
  severity: string
) {
  if (!state.notificationsChannelId) {
    return { content: [{ type: 'text' as const, text: 'notifications channel not configured' }] }
  }
  const emoji = SEVERITY_EMOJI[severity] || '📋'
  const channel = await discord.channels.fetch(state.notificationsChannelId)
  if (!channel?.isTextBased()) {
    return { content: [{ type: 'text' as const, text: 'notifications channel not found' }] }
  }
  const msg = await (channel as TextChannel).send(`${emoji} ${text}`)
  return { content: [{ type: 'text' as const, text: `posted (message_id: ${msg.id})` }] }
}

async function handleCreateWorkerThread(
  discord: Client,
  state: ChannelState,
  channelId: string,
  workerName: string
) {
  const channel = await discord.channels.fetch(channelId)
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { content: [{ type: 'text' as const, text: `Channel ${channelId} not found or not a text channel` }] }
  }

  // Create thread
  const thread = await (channel as TextChannel).threads.create({
    name: workerName,
    autoArchiveDuration: 10080, // 7 days
  })

  // Post and pin status message
  const statusMsg = await thread.send(`**Status:** STARTING | Worker initializing...`)
  await statusMsg.pin()

  // Register in state
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

async function handleUpdateStatus(
  discord: Client,
  state: ChannelState,
  workerName: string,
  status: string,
  summary: string
) {
  const worker = state.workers[workerName]
  if (!worker) {
    return { content: [{ type: 'text' as const, text: `Worker ${workerName} not found in state` }] }
  }

  try {
    const thread = await discord.channels.fetch(worker.threadId)
    if (thread?.isTextBased()) {
      const statusMsg = await (thread as ThreadChannel).messages.fetch(worker.statusMessageId)
      await statusMsg.edit(`**Status:** ${status.toUpperCase()} | ${summary}`)
      return { content: [{ type: 'text' as const, text: `status updated` }] }
    }
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Failed to update status: ${err}` }] }
  }

  return { content: [{ type: 'text' as const, text: 'thread not found' }] }
}

async function handleUpdateContext(
  discord: Client,
  state: ChannelState,
  projectName: string,
  newContext: string
) {
  const project = state.projects[projectName]
  if (!project) {
    return { content: [{ type: 'text' as const, text: `Project ${projectName} not found in state` }] }
  }

  try {
    const channel = await discord.channels.fetch(project.channelId)
    if (channel?.isTextBased()) {
      const contextMsg = await (channel as TextChannel).messages.fetch(project.contextMessageId)
      await contextMsg.edit(newContext)
      project.context = newContext
      saveState(state)
      return { content: [{ type: 'text' as const, text: 'context updated' }] }
    }
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Failed to update context: ${err}` }] }
  }

  return { content: [{ type: 'text' as const, text: 'channel not found' }] }
}

async function handleCreateProjectChannel(
  discord: Client,
  state: ChannelState,
  name: string,
  context: string
) {
  // Find the guild
  const guildId = process.env.GUILD_ID
  if (!guildId) {
    return { content: [{ type: 'text' as const, text: 'GUILD_ID not configured' }] }
  }

  const guild = await discord.guilds.fetch(guildId)

  // Create channel
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
  } as GuildChannelCreateOptions)

  // Post and pin context
  const contextMsg = await channel.send(context)
  await contextMsg.pin()

  // Register in state
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

async function handleAddReaction(
  discord: Client,
  channelId: string,
  messageId: string,
  emoji: string
) {
  try {
    const channel = await discord.channels.fetch(channelId)
    if (channel?.isTextBased()) {
      const msg = await (channel as TextChannel).messages.fetch(messageId)
      await msg.react(emoji)
      return { content: [{ type: 'text' as const, text: 'reaction added' }] }
    }
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Failed to add reaction: ${err}` }] }
  }

  return { content: [{ type: 'text' as const, text: 'channel not found' }] }
}
