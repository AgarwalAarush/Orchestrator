import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as discord from './discord-rest.js'
import type { ChannelState } from './state.js'

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')
const STALE_THRESHOLD_SECONDS = 600 // 10 minutes
const CHECK_INTERVAL_MS = 60_000 // 1 minute

/**
 * Periodically checks worker heartbeats.
 * If a running worker's heartbeat is stale (>10 min), posts a warning to Discord.
 */
export function startMonitor(state: ChannelState): void {
  const warned = new Set<string>() // track which workers we already warned about

  setInterval(async () => {
    const workersDir = join(ORCH_HOME, 'workers')
    if (!existsSync(workersDir)) return

    const now = Math.floor(Date.now() / 1000)

    let dirs: string[]
    try {
      dirs = readdirSync(workersDir)
    } catch {
      return
    }

    for (const name of dirs) {
      const workerDir = join(workersDir, name)
      const statusFile = join(workerDir, 'status')
      const heartbeatFile = join(workerDir, 'heartbeat')

      if (!existsSync(statusFile) || !existsSync(heartbeatFile)) continue

      const status = readFileSync(statusFile, 'utf-8').trim()
      if (status !== 'running') {
        warned.delete(name)
        continue
      }

      const heartbeat = parseInt(readFileSync(heartbeatFile, 'utf-8').trim(), 10)
      if (isNaN(heartbeat)) continue

      const age = now - heartbeat

      if (age > STALE_THRESHOLD_SECONDS && !warned.has(name)) {
        warned.add(name)
        const minutes = Math.floor(age / 60)
        const message = `\u26A0\uFE0F **[${name}]** Heartbeat stale (${minutes}m). Worker may be stuck.`

        // Post warning to worker thread if known
        const workerInfo = state.workers[name]
        if (workerInfo?.threadId) {
          discord.sendMessage(workerInfo.threadId, message).catch(() => {})
        }

        // Post to #notifications
        const notifId = process.env.NOTIFICATIONS_CHANNEL_ID || state.notificationsChannelId
        if (notifId) {
          discord.sendMessage(notifId, message).catch(() => {})
        }

        console.error(`[monitor] Worker ${name} heartbeat stale: ${minutes}m`)
      }

      // Clear warning if heartbeat recovers
      if (age <= STALE_THRESHOLD_SECONDS && warned.has(name)) {
        warned.delete(name)
      }
    }
  }, CHECK_INTERVAL_MS)

  console.error('[monitor] Heartbeat monitor started (checking every 60s)')
}
