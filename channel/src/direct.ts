import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')
const TMUX_PREFIX = 'orch-'

/**
 * Route a message directly to a worker's inbox and nudge via tmux.
 * This bypasses the main Claude session entirely.
 */
export function routeToWorker(workerName: string, message: string): void {
  const inboxDir = join(ORCH_HOME, 'workers', workerName, 'inbox')

  // Ensure inbox exists
  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true })
  }

  // Find next inbox number
  let maxNum = 0
  try {
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.md'))
    for (const f of files) {
      const num = parseInt(f.replace('.md', ''), 10)
      if (!isNaN(num) && num > maxNum) maxNum = num
    }
  } catch {
    // empty dir is fine
  }

  const nextNum = String(maxNum + 1).padStart(3, '0')
  const timestamp = new Date().toISOString()

  // Write directive to inbox
  const content = `# Directive ${nextNum}\nReceived: ${timestamp}\n\n${message}\n`
  writeFileSync(join(inboxDir, `${nextNum}.md`), content, 'utf-8')

  // Nudge worker via tmux
  const tmuxSession = `${TMUX_PREFIX}${workerName}`
  try {
    execSync(
      `tmux send-keys -t "${tmuxSession}" "Check your inbox at ${ORCH_HOME}/workers/${workerName}/inbox/ for new directives." Enter`,
      { stdio: 'ignore', timeout: 5000 }
    )
  } catch {
    // tmux session may be dead — directive is still in inbox
    console.error(`[direct] tmux session ${tmuxSession} not reachable. Directive written to inbox.`)
  }
}

/**
 * Check if a worker's tmux session is alive.
 */
export function isWorkerAlive(workerName: string): boolean {
  const tmuxSession = `${TMUX_PREFIX}${workerName}`
  try {
    execSync(`tmux has-session -t "${tmuxSession}"`, { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}
