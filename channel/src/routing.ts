import { Message, Client, ChannelType } from 'discord.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ChannelState } from './state.js'
import { getWorkerByThreadId, getProjectByChannelId, isSenderAllowed } from './state.js'
import { routeToWorker } from './direct.js'
import { handleVerdictIfMatch } from './permissions.js'

/**
 * Route a Discord message to the appropriate handler.
 *
 * Decision tree:
 * 1. Ignore bot messages
 * 2. Check sender allowlist
 * 3. Ignore #notifications
 * 4. Check for permission verdict (yes/no + id)
 * 5. Worker thread → direct route to worker (no main session)
 * 6. #main → mcp.notification to main session
 * 7. Project channel (top-level) → mcp.notification with project context
 * 8. Else → ignore
 */
export async function routeMessage(
  message: Message,
  mcp: Server,
  discord: Client,
  state: ChannelState
): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return

  // Check sender
  if (!isSenderAllowed(state, message.author.id)) return

  const content = message.content.trim()
  if (!content) return

  const channelId = message.channelId

  // Ignore #notifications (read-only)
  if (channelId === state.notificationsChannelId) return

  // Check for permission verdict anywhere
  const isVerdict = await handleVerdictIfMatch(
    content, mcp, discord, state, message.id
  )
  if (isVerdict) return

  // Check if message is in a thread
  const channel = message.channel
  const isThread = channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread

  if (isThread) {
    // Check if this thread maps to a worker
    const worker = getWorkerByThreadId(state, channelId)
    if (worker) {
      // Direct route to worker — no main session involved
      routeToWorker(worker.name, content)
      try {
        await message.reply('📨 Directive sent')
      } catch {
        // reply failed, not critical
      }
      return
    }
  }

  // #main channel
  if (channelId === state.mainChannelId) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          channel: 'main',
          sender: message.author.username,
          sender_id: message.author.id,
          message_id: message.id,
        },
      },
    })
    return
  }

  // #quick-tasks (top-level, not a thread — treat like #main)
  if (channelId === state.quickTasksChannelId && !isThread) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          channel: 'quick_tasks',
          sender: message.author.username,
          sender_id: message.author.id,
          message_id: message.id,
        },
      },
    })
    return
  }

  // Project channel (top-level message, not in a thread)
  if (!isThread) {
    const project = getProjectByChannelId(state, channelId)
    if (project) {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            channel: project.name,
            project: 'true',
            sender: message.author.username,
            sender_id: message.author.id,
            message_id: message.id,
          },
        },
      })
      return
    }
  }

  // If in a thread whose parent is a project channel, check parent
  if (isThread && 'parentId' in channel && channel.parentId) {
    const project = getProjectByChannelId(state, channel.parentId)
    if (project) {
      // Thread in a project channel but NOT a registered worker thread
      // Forward to main session as project context
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            channel: project.name,
            project: 'true',
            thread: 'true',
            sender: message.author.username,
            sender_id: message.author.id,
            message_id: message.id,
          },
        },
      })
      return
    }
  }

  // Unknown channel — ignore
}
