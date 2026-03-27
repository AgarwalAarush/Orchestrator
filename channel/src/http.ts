import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import * as discord from './discord-rest.js'
import type { ChannelState } from './state.js'

const SEVERITY_EMOJI: Record<string, string> = {
  done: '\u2705',
  update: '\uD83D\uDCCB',
  error: '\u274C',
  blocked: '\uD83D\uDEAB',
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

function loadConfig(): Record<string, any> {
  const orchHome = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')
  try {
    return JSON.parse(readFileSync(join(orchHome, 'config.json'), 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Start the HTTP listener for worker notifications.
 * Workers POST to /notify with { worker, event, summary }.
 * Posts directly to Discord via REST API and pushes MCP notification to Claude.
 */
export function startHttpListener(port: number, mcp: Server, state: ChannelState): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

      const emoji = SEVERITY_EMOJI[data.event] || '\uD83D\uDCCB'
      const workerInfo = state.workers[data.worker]

      // 1. Post in worker thread (if registered in state)
      if (workerInfo?.threadId) {
        try {
          await discord.sendMessage(workerInfo.threadId, `${emoji} ${data.summary}`)
        } catch (err) {
          console.error(`[http] Failed to post in worker thread:`, err)
        }
      }

      // 2. Post in #notifications
      const notifChannelId = process.env.NOTIFICATIONS_CHANNEL_ID || state.notificationsChannelId
      if (notifChannelId) {
        try {
          await discord.sendMessage(notifChannelId, `${emoji} **[${data.worker}]** ${data.summary}`)
        } catch (err) {
          console.error(`[http] Failed to post notification:`, err)
        }
      }

      // 3. Update pinned status message in worker thread
      if (workerInfo?.statusMessageId && workerInfo?.threadId) {
        try {
          const statusText = data.event === 'done' ? 'DONE' :
                             data.event === 'error' ? 'ERROR' :
                             data.event === 'blocked' ? 'BLOCKED' : 'RUNNING'
          await discord.editMessage(workerInfo.threadId, workerInfo.statusMessageId,
            `**Status:** ${statusText} | ${data.summary}`)
        } catch (err) {
          console.error(`[http] Failed to update status message:`, err)
        }
      }

      // 4. Notify main session via MCP channel push
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

      // 5. Optional: iMessage ping for done/error events
      try {
        const config = loadConfig()
        if (config.imessage?.enabled && config.imessage?.recipient &&
            (config.imessage?.notify_events || ['done', 'error']).includes(data.event)) {
          const msg = `${emoji} [${data.worker}] ${data.summary}`
          const escaped = msg.replace(/"/g, '\\"')
          execSync(
            `osascript -e 'tell application "Messages" to send "${escaped}" to buddy "${config.imessage.recipient}"'`,
            { stdio: 'ignore', timeout: 5000 }
          )
        }
      } catch {
        // iMessage is best-effort
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
