import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import * as discord from './discord-rest.js'
import type { ChannelState } from './state.js'

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')
const STALE_THRESHOLD_SECONDS = 600 // 10 minutes
const CHECK_INTERVAL_MS = 60_000 // 1 minute

function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}"`, { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function isClaudeRunningInSession(sessionName: string): boolean {
  try {
    // Check if any claude process is running in this tmux session
    const pane_pid = execSync(`tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`, { timeout: 3000 })
      .toString().trim()
    if (!pane_pid) return false
    // Check if claude is a child of the pane's shell
    execSync(`pgrep -P ${pane_pid} -f claude`, { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function readWorkerMeta(name: string): Record<string, any> | null {
  const metaPath = join(ORCH_HOME, 'workers', name, 'meta.json')
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

function loadConfig(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(ORCH_HOME, 'config.json'), 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Attempt to auto-resume a crashed worker by running `claude --continue` in its tmux session.
 */
function autoResumeWorker(name: string, meta: Record<string, any>): void {
  const sessionName = meta.tmux_session || `orch-${name}`
  const workerDir = join(ORCH_HOME, 'workers', name)

  const model = meta.model || 'sonnet'
  const systemPromptFile = join(workerDir, 'system-prompt.md')
  const settingsFile = join(workerDir, 'settings.json')

  let cmd = `claude --continue --name '${name}' --model '${model}'`
  if (existsSync(systemPromptFile)) cmd += ` --system-prompt-file '${systemPromptFile}'`
  if (existsSync(settingsFile)) cmd += ` --settings '${settingsFile}'`
  cmd += ` --add-dir '${workerDir}'`
  cmd += ' --dangerously-skip-permissions'

  try {
    // Set env vars
    execSync(`tmux send-keys -t "${sessionName}" "export ORCH_WORKER_NAME='${name}' ORCH_HOME='${ORCH_HOME}'" Enter`, { stdio: 'ignore', timeout: 5000 })
    // Launch claude --continue
    execSync(`tmux send-keys -t "${sessionName}" "${cmd}" Enter`, { stdio: 'ignore', timeout: 5000 })

    // Handle the permissions prompt (Down + Enter)
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t "${sessionName}" Down`, { stdio: 'ignore', timeout: 3000 })
        setTimeout(() => {
          try {
            execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'ignore', timeout: 3000 })
          } catch { /* ignore */ }
        }, 500)
      } catch { /* ignore */ }
    }, 4000)

    console.error(`[monitor] Auto-resumed worker ${name}`)
  } catch (err) {
    console.error(`[monitor] Failed to auto-resume worker ${name}:`, err)
  }
}

/**
 * Periodically checks worker heartbeats and auto-resumes crashed workers.
 */
export function startMonitor(state: ChannelState): void {
  const warned = new Set<string>()
  const resumed = new Set<string>() // track resumed workers to avoid repeated attempts
  const config = loadConfig()
  const autoResume = config.auto_resume !== false // default true

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
        resumed.delete(name)
        continue
      }

      const heartbeat = parseInt(readFileSync(heartbeatFile, 'utf-8').trim(), 10)
      if (isNaN(heartbeat)) continue

      const age = now - heartbeat
      const sessionName = `orch-${name}`

      // Check for crashed worker: tmux alive but claude not running
      if (age > STALE_THRESHOLD_SECONDS && autoResume && !resumed.has(name)) {
        if (tmuxSessionExists(sessionName) && !isClaudeRunningInSession(sessionName)) {
          resumed.add(name)
          const meta = readWorkerMeta(name)
          if (meta) {
            const message = `\u26A0\uFE0F **[${name}]** Worker crashed. Auto-resuming...`
            const notifId = process.env.NOTIFICATIONS_CHANNEL_ID || state.notificationsChannelId
            if (notifId) discord.sendMessage(notifId, message).catch(() => {})
            const workerInfo = state.workers[name]
            if (workerInfo?.threadId) discord.sendMessage(workerInfo.threadId, message).catch(() => {})

            autoResumeWorker(name, meta)
            console.error(`[monitor] Worker ${name} crashed, auto-resuming`)
            continue
          }
        }
      }

      // Standard stale heartbeat warning
      if (age > STALE_THRESHOLD_SECONDS && !warned.has(name)) {
        warned.add(name)
        const minutes = Math.floor(age / 60)
        const message = `\u26A0\uFE0F **[${name}]** Heartbeat stale (${minutes}m). Worker may be stuck.`

        const workerInfo = state.workers[name]
        if (workerInfo?.threadId) {
          discord.sendMessage(workerInfo.threadId, message).catch(() => {})
        }

        const notifId = process.env.NOTIFICATIONS_CHANNEL_ID || state.notificationsChannelId
        if (notifId) {
          discord.sendMessage(notifId, message).catch(() => {})
        }

        console.error(`[monitor] Worker ${name} heartbeat stale: ${minutes}m`)
      }

      if (age <= STALE_THRESHOLD_SECONDS && warned.has(name)) {
        warned.delete(name)
      }
    }

    // Check for waiting workers with satisfied dependencies (Feature 12)
    for (const name of dirs) {
      const workerDir = join(workersDir, name)
      const statusFile = join(workerDir, 'status')
      if (!existsSync(statusFile)) continue

      const status = readFileSync(statusFile, 'utf-8').trim()
      if (status !== 'waiting') continue

      const meta = readWorkerMeta(name)
      if (!meta?.depends_on) continue

      const depStatus = join(workersDir, meta.depends_on, 'status')
      if (existsSync(depStatus) && readFileSync(depStatus, 'utf-8').trim() === 'done') {
        console.error(`[monitor] Dependency satisfied for ${name}, launching...`)
        try {
          execSync(`orch spawn-deferred ${name}`, { stdio: 'ignore', timeout: 30000 })
        } catch (err) {
          console.error(`[monitor] Failed to launch deferred worker ${name}:`, err)
        }
      }
    }
  }, CHECK_INTERVAL_MS)

  console.error('[monitor] Heartbeat monitor started (checking every 60s, auto-resume: ' + autoResume + ')')
}
