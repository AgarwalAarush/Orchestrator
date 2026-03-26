import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client, TextChannel, ThreadChannel } from 'discord.js'
import type { ChannelState } from './state.js'
import { saveState } from './state.js'

const SEVERITY_EMOJI: Record<string, string> = {
  done: '✅',
  update: '📋',
  error: '❌',
  blocked: '🚫',
}

interface WorkerNotification {
  worker: string
  event: string
  summary: string
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * Start the HTTP listener for worker notifications.
 * Workers POST to /notify with { worker, event, summary }.
 */
export function startHttpListener(
  port: number,
  mcp: Server,
  discord: Client,
  state: ChannelState
): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only handle POST /notify
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404)
      res.end('not found')
      return
    }

    try {
      const body = await parseBody(req)
      const data: WorkerNotification = JSON.parse(body)

      if (!data.worker || !data.event || !data.summary) {
        res.writeHead(400)
        res.end('missing fields: worker, event, summary')
        return
      }

      const emoji = SEVERITY_EMOJI[data.event] || '📋'
      const workerInfo = state.workers[data.worker]

      // 1. Post in worker thread (if registered in state)
      if (workerInfo?.threadId) {
        try {
          const thread = await discord.channels.fetch(workerInfo.threadId)
          if (thread?.isTextBased()) {
            await (thread as ThreadChannel).send(`${emoji} ${data.summary}`)
          }
        } catch (err) {
          console.error(`[http] Failed to post in worker thread:`, err)
        }
      }

      // 2. Post in #notifications
      if (state.notificationsChannelId) {
        try {
          const notifChannel = await discord.channels.fetch(state.notificationsChannelId)
          if (notifChannel?.isTextBased()) {
            await (notifChannel as TextChannel).send(
              `${emoji} **[${data.worker}]** ${data.summary}`
            )
          }
        } catch (err) {
          console.error(`[http] Failed to post notification:`, err)
        }
      }

      // 3. Update pinned status message in worker thread
      if (workerInfo?.statusMessageId && workerInfo?.threadId) {
        try {
          const thread = await discord.channels.fetch(workerInfo.threadId)
          if (thread?.isTextBased()) {
            const statusMsg = await (thread as ThreadChannel).messages.fetch(workerInfo.statusMessageId)
            const statusText = data.event === 'done' ? 'DONE' :
                               data.event === 'error' ? 'ERROR' :
                               data.event === 'blocked' ? 'BLOCKED' : 'RUNNING'
            await statusMsg.edit(`**Status:** ${statusText} | ${data.summary}`)
          }
        } catch (err) {
          console.error(`[http] Failed to update status message:`, err)
        }
      }

      // 4. Notify main session via MCP so Claude can update project context
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: data.summary,
            meta: {
              source: 'worker',
              worker: data.worker,
              event: data.event,
            },
          },
        })
      } catch (err) {
        console.error(`[http] Failed to send MCP notification:`, err)
      }

      res.writeHead(200)
      res.end('ok')
    } catch (err) {
      console.error('[http] Error handling notification:', err)
      res.writeHead(500)
      res.end('internal error')
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.error(`[http] Listening on http://127.0.0.1:${port}`)
  })
}
