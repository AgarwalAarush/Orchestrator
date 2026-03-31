import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import * as discord from './discord-rest.js'
import type { ChannelState } from './state.js'
import { renderDashboard, getWorkersJson, getProjectsJson } from './dashboard.js'

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
    // GET routes — dashboard and API
    if (req.method === 'GET') {
      if (req.url === '/' || req.url === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(renderDashboard())
        return
      }
      if (req.url === '/api/workers') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getWorkersJson()))
        return
      }
      if (req.url === '/api/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getProjectsJson()))
        return
      }
    }

    // POST /memory — worker signals a memory was created/updated
    if (req.method === 'POST' && req.url === '/memory') {
      try {
        const body = await parseBody(req)
        const data = JSON.parse(body) as { worker: string; action: string; layer: string; id: string; project?: string }
        await handleMemorySignal(data, mcp, state)
        res.writeHead(200)
        res.end(JSON.stringify({ indexed: true }))
      } catch (err) {
        console.error('[http] Error handling memory signal:', err)
        res.writeHead(500)
        res.end('error')
      }
      return
    }

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

      // 2. Post in #notifications (use embeds for done/error/blocked, plain text for updates)
      const notifChannelId = process.env.NOTIFICATIONS_CHANNEL_ID || state.notificationsChannelId
      if (notifChannelId) {
        try {
          if (['done', 'error', 'blocked'].includes(data.event)) {
            const EMBED_COLORS: Record<string, number> = {
              done: 0x2ecc71,    // green
              error: 0xe74c3c,   // red
              blocked: 0xe67e22,  // orange
            }
            await discord.sendEmbed(notifChannelId, {
              title: `${emoji} ${data.worker}`,
              description: data.summary,
              color: EMBED_COLORS[data.event] || 0x3498db,
              footer: { text: data.event.toUpperCase() },
              timestamp: new Date().toISOString(),
            })
          } else {
            await discord.sendMessage(notifChannelId, `${emoji} **[${data.worker}]** ${data.summary}`)
          }
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

/**
 * Handle a memory signal from a worker.
 * Rebuilds the memory index by shelling out to `orch memory rebuild`.
 */
async function handleMemorySignal(
  data: { worker: string; action: string; layer: string; id: string; project?: string },
  mcp: Server,
  state: ChannelState
): Promise<void> {
  const { worker, action, layer, id, project } = data
  console.error(`[http] Memory signal: ${action} ${layer}/${id} from ${worker}`)

  // Rebuild the relevant index via orch CLI
  try {
    if (layer === 'user') {
      execSync('orch memory rebuild --user', { stdio: 'ignore', timeout: 5000 })
    } else if (layer === 'project' && project) {
      execSync(`orch memory rebuild --project "${project}"`, { stdio: 'ignore', timeout: 5000 })
    } else if (layer === 'worker') {
      // Worker memory doesn't need index rebuild for others, but we could notify
    }
  } catch (err) {
    console.error('[http] Failed to rebuild memory index:', err)
  }

  // Notify main session that a memory was added
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `Memory "${id}" ${action === 'add' ? 'created' : 'updated'} by worker ${worker} in ${layer}${project ? `:${project}` : ''}`,
        meta: {
          source: 'memory',
          worker,
          action,
          layer,
          memory_id: id,
        },
      },
    })
  } catch (err) {
    console.error('[http] Failed to notify about memory:', err)
  }
}
