import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')

interface WorkerData {
  name: string
  status: string
  model: string
  project: string | null
  uptime: string
  heartbeat: string
  toolCount: number
  tmuxAlive: boolean
}

interface ProjectData {
  name: string
  status: string
  memoryCount: number
  channelId: string | null
}

function getWorkers(): WorkerData[] {
  const workersDir = join(ORCH_HOME, 'workers')
  if (!existsSync(workersDir)) return []

  const now = Math.floor(Date.now() / 1000)
  const workers: WorkerData[] = []

  for (const name of readdirSync(workersDir)) {
    const dir = join(workersDir, name)
    const statusFile = join(dir, 'status')
    const metaFile = join(dir, 'meta.json')
    const heartbeatFile = join(dir, 'heartbeat')
    const toolCountFile = join(dir, 'tool_count')

    if (!existsSync(statusFile)) continue

    const status = readFileSync(statusFile, 'utf-8').trim()
    let model = '?', project: string | null = null
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8'))
      model = meta.model || '?'
      project = meta.project || null
    } catch {}

    let heartbeat = '?'
    try {
      const hb = parseInt(readFileSync(heartbeatFile, 'utf-8').trim(), 10)
      const age = now - hb
      heartbeat = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`
    } catch {}

    let toolCount = 0
    try { toolCount = parseInt(readFileSync(toolCountFile, 'utf-8').trim(), 10) || 0 } catch {}

    workers.push({ name, status, model, project, uptime: '?', heartbeat, toolCount, tmuxAlive: false })
  }

  return workers
}

function getProjects(): ProjectData[] {
  const projectsDir = join(ORCH_HOME, 'projects')
  const stateFile = join(ORCH_HOME, 'channel-state.json')
  const projects: ProjectData[] = []

  let state: any = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')) } catch {}

  if (state.projects) {
    for (const [name, info] of Object.entries(state.projects) as any) {
      let memoryCount = 0
      const memDir = join(projectsDir, name, 'memory')
      if (existsSync(memDir)) {
        memoryCount = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== '_index.md').length
      }
      projects.push({
        name,
        status: 'active',
        memoryCount,
        channelId: info.channelId || null,
      })
    }
  }

  return projects
}

export function renderDashboard(): string {
  const workers = getWorkers()
  const projects = getProjects()

  const statusColor = (s: string) => {
    if (s === 'running') return '#2ecc71'
    if (s === 'done') return '#3498db'
    if (s === 'error') return '#e74c3c'
    if (s === 'killed') return '#95a5a6'
    if (s === 'waiting') return '#f39c12'
    return '#bdc3c7'
  }

  const workerRows = workers.map(w => `
    <tr>
      <td><strong>${w.name}</strong></td>
      <td><span style="color:${statusColor(w.status)}">${w.status}</span></td>
      <td>${w.model}</td>
      <td>${w.project || '-'}</td>
      <td>${w.heartbeat}</td>
      <td>${w.toolCount}</td>
    </tr>`).join('')

  const projectRows = projects.map(p => `
    <tr>
      <td><strong>${p.name}</strong></td>
      <td>${p.status}</td>
      <td>${p.memoryCount}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Orchestrator</title>
  <meta http-equiv="refresh" content="30">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; padding: 2rem; }
    h1 { color: #7c3aed; margin-bottom: 0.5rem; }
    h2 { color: #a78bfa; margin: 1.5rem 0 0.5rem; }
    .subtitle { color: #888; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    th { text-align: left; padding: 0.5rem; border-bottom: 2px solid #333; color: #a78bfa; }
    td { padding: 0.5rem; border-bottom: 1px solid #222; }
    tr:hover { background: #222; }
    .empty { color: #666; font-style: italic; padding: 1rem; }
    .stats { display: flex; gap: 2rem; margin-bottom: 1.5rem; }
    .stat { background: #222; padding: 1rem 1.5rem; border-radius: 8px; }
    .stat-value { font-size: 2rem; font-weight: bold; color: #7c3aed; }
    .stat-label { color: #888; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Claude Orchestrator</h1>
  <p class="subtitle">Auto-refreshes every 30 seconds</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${workers.filter(w => w.status === 'running').length}</div>
      <div class="stat-label">Active Workers</div>
    </div>
    <div class="stat">
      <div class="stat-value">${workers.length}</div>
      <div class="stat-label">Total Workers</div>
    </div>
    <div class="stat">
      <div class="stat-value">${projects.length}</div>
      <div class="stat-label">Projects</div>
    </div>
  </div>

  <h2>Workers</h2>
  ${workers.length > 0 ? `
  <table>
    <tr><th>Name</th><th>Status</th><th>Model</th><th>Project</th><th>Heartbeat</th><th>Tools</th></tr>
    ${workerRows}
  </table>` : '<p class="empty">No workers</p>'}

  <h2>Projects</h2>
  ${projects.length > 0 ? `
  <table>
    <tr><th>Name</th><th>Status</th><th>Memories</th></tr>
    ${projectRows}
  </table>` : '<p class="empty">No projects</p>'}
</body>
</html>`
}

export function getWorkersJson(): WorkerData[] { return getWorkers() }
export function getProjectsJson(): ProjectData[] { return getProjects() }
