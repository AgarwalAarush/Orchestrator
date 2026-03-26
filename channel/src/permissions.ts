import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client, TextChannel, ThreadChannel } from 'discord.js'
import { z } from 'zod'
import type { ChannelState } from './state.js'
import { addPendingPermission, removePendingPermission, saveState } from './state.js'

const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

/**
 * Register the permission request handler on the MCP server.
 * When Claude Code asks a worker for permission, this posts the request
 * in the worker's Discord thread.
 */
export function registerPermissionHandler(
  mcp: Server,
  discord: Client,
  state: ChannelState
): void {
  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params

    // Find which worker this permission is for by checking thread context
    // For now, post in the first worker thread found (will be refined when
    // we track which worker session the permission came from)
    // TODO: map permission requests to specific workers via session tracking

    const message = [
      `🔐 **Permission Request**`,
      `Tool: \`${tool_name}\``,
      `${description}`,
      '',
      '```',
      input_preview.slice(0, 500),
      '```',
      '',
      `Reply: \`yes ${request_id}\` or \`no ${request_id}\``,
    ].join('\n')

    // Try to post in a relevant thread — for now, use the main channel
    try {
      const mainChannel = await discord.channels.fetch(state.mainChannelId)
      if (mainChannel?.isTextBased()) {
        const sent = await (mainChannel as TextChannel).send(message)
        addPendingPermission(state, {
          requestId: request_id,
          threadId: state.mainChannelId,
          workerName: 'unknown', // refined later
          messageId: sent.id,
        })
      }
    } catch (err) {
      console.error('[permissions] Failed to post permission request:', err)
    }
  })
}

/**
 * Check if a message is a permission verdict (yes/no + request_id).
 * If so, emit the verdict to Claude Code and return true.
 */
export async function handleVerdictIfMatch(
  text: string,
  mcp: Server,
  discord: Client,
  state: ChannelState,
  messageId: string
): Promise<boolean> {
  const match = VERDICT_RE.exec(text)
  if (!match) return false

  const approved = match[1].toLowerCase().startsWith('y')
  const requestId = match[2].toLowerCase()

  const perm = removePendingPermission(state, requestId)
  if (!perm) {
    console.error(`[permissions] No pending permission for request_id: ${requestId}`)
    return false
  }

  // Emit verdict to Claude Code
  try {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: requestId,
        behavior: approved ? 'allow' : 'deny',
      },
    })
  } catch (err) {
    console.error('[permissions] Failed to emit verdict:', err)
  }

  // React to the verdict message
  try {
    const channel = await discord.channels.fetch(perm.threadId)
    if (channel?.isTextBased()) {
      const msg = await (channel as TextChannel).messages.fetch(perm.messageId)
      await msg.react(approved ? '✅' : '❌')
    }
  } catch {
    // reaction failed, not critical
  }

  return true
}
