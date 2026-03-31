import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')

interface WorkerData {
  name: string
  status: string
  model: string
  project: string | null
  uptime: string
  heartbeat: string
  heartbeatAge: number
  toolCount: number
  tmuxAlive: boolean
  task: string
}

interface ProjectData {
  name: string
  status: string
  memoryCount: number
  channelId: string | null
  workerCount: number
}

interface MemoryData {
  layer: string
  id: string
  title: string
  category: string
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

function tmuxAlive(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}"`, { stdio: 'ignore', timeout: 2000 })
    return true
  } catch { return false }
}

function getWorkers(): WorkerData[] {
  const workersDir = join(ORCH_HOME, 'workers')
  if (!existsSync(workersDir)) return []

  const now = Math.floor(Date.now() / 1000)
  const workers: WorkerData[] = []

  for (const name of readdirSync(workersDir)) {
    const dir = join(workersDir, name)
    if (!statSync(dir).isDirectory()) continue
    const statusFile = join(dir, 'status')
    const metaFile = join(dir, 'meta.json')
    const heartbeatFile = join(dir, 'heartbeat')
    const toolCountFile = join(dir, 'tool_count')
    const taskFile = join(dir, 'task')

    if (!existsSync(statusFile)) continue

    const status = readFileSync(statusFile, 'utf-8').trim()
    let model = '?', project: string | null = null, created = ''
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8'))
      model = meta.model || '?'
      project = meta.project || null
      created = meta.created || ''
    } catch {}

    let heartbeat = '-', heartbeatAge = 999999
    try {
      const hb = parseInt(readFileSync(heartbeatFile, 'utf-8').trim(), 10)
      heartbeatAge = now - hb
      heartbeat = humanDuration(heartbeatAge) + ' ago'
    } catch {}

    let uptime = '-'
    if (created) {
      try {
        const createdMs = new Date(created).getTime()
        uptime = humanDuration(Math.floor((Date.now() - createdMs) / 1000))
      } catch {}
    }

    let toolCount = 0
    try { toolCount = parseInt(readFileSync(toolCountFile, 'utf-8').trim(), 10) || 0 } catch {}

    let task = ''
    try { task = readFileSync(taskFile, 'utf-8').trim().slice(0, 100) } catch {}

    const sessionName = `orch-${name}`
    workers.push({ name, status, model, project, uptime, heartbeat, heartbeatAge, toolCount, tmuxAlive: tmuxAlive(sessionName), task })
  }

  // Sort: running first, then by name
  workers.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return a.name.localeCompare(b.name)
  })

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

      // Count workers for this project
      let workerCount = 0
      const workersDir = join(ORCH_HOME, 'workers')
      if (existsSync(workersDir)) {
        for (const wname of readdirSync(workersDir)) {
          try {
            const meta = JSON.parse(readFileSync(join(workersDir, wname, 'meta.json'), 'utf-8'))
            if (meta.project === name) workerCount++
          } catch {}
        }
      }

      projects.push({
        name,
        status: 'active',
        memoryCount,
        channelId: info.channelId || null,
        workerCount,
      })
    }
  }

  return projects
}

function getRecentMemories(): MemoryData[] {
  const memories: MemoryData[] = []

  // User memories
  const userDir = join(ORCH_HOME, 'memory', 'user')
  if (existsSync(userDir)) {
    for (const f of readdirSync(userDir).filter(f => f.endsWith('.md') && f !== '_index.md')) {
      try {
        const content = readFileSync(join(userDir, f), 'utf-8')
        const title = content.match(/^title:\s*(.+)$/m)?.[1] || f.replace('.md', '')
        const category = content.match(/^category:\s*(.+)$/m)?.[1] || 'reference'
        memories.push({ layer: 'user', id: f.replace('.md', ''), title, category })
      } catch {}
    }
  }

  // Project memories
  const projectsDir = join(ORCH_HOME, 'projects')
  if (existsSync(projectsDir)) {
    for (const pname of readdirSync(projectsDir)) {
      const memDir = join(projectsDir, pname, 'memory')
      if (!existsSync(memDir)) continue
      for (const f of readdirSync(memDir).filter(f => f.endsWith('.md') && f !== '_index.md')) {
        try {
          const content = readFileSync(join(memDir, f), 'utf-8')
          const title = content.match(/^title:\s*(.+)$/m)?.[1] || f.replace('.md', '')
          const category = content.match(/^category:\s*(.+)$/m)?.[1] || 'reference'
          memories.push({ layer: pname, id: f.replace('.md', ''), title, category })
        } catch {}
      }
    }
  }

  return memories
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderDashboard(): string {
  const workers = getWorkers()
  const projects = getProjects()
  const memories = getRecentMemories()

  const activeWorkers = workers.filter(w => w.status === 'running')
  const totalTools = workers.reduce((sum, w) => sum + w.toolCount, 0)

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      running: 'bg-green', done: 'bg-blue', error: 'bg-red',
      killed: 'bg-gray', waiting: 'bg-yellow', starting: 'bg-yellow',
    }
    return `<span class="badge ${colors[s] || 'bg-gray'}">${esc(s)}</span>`
  }

  const categoryBadge = (c: string) => {
    const colors: Record<string, string> = {
      environment: 'bg-teal', 'experiment-result': 'bg-purple', decision: 'bg-blue',
      preference: 'bg-pink', procedure: 'bg-orange', warning: 'bg-red', reference: 'bg-gray',
    }
    return `<span class="badge badge-sm ${colors[c] || 'bg-gray'}">${esc(c)}</span>`
  }

  const workerRows = workers.map(w => {
    const stale = w.status === 'running' && w.heartbeatAge > 600
    return `
    <tr${stale ? ' class="stale"' : ''}>
      <td>
        <div class="worker-name">${esc(w.name)}</div>
        ${w.task ? `<div class="worker-task">${esc(w.task)}</div>` : ''}
      </td>
      <td>${statusBadge(w.status)}${!w.tmuxAlive && w.status === 'running' ? ' <span class="badge bg-red badge-sm">tmux dead</span>' : ''}</td>
      <td><span class="model-tag">${esc(w.model)}</span></td>
      <td>${w.project ? esc(w.project) : '<span class="dim">-</span>'}</td>
      <td class="mono">${esc(w.uptime)}</td>
      <td class="mono${stale ? ' text-warning' : ''}">${esc(w.heartbeat)}</td>
      <td class="mono">${w.toolCount.toLocaleString()}</td>
    </tr>`
  }).join('')

  const projectRows = projects.map(p => `
    <tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td class="mono">${p.workerCount}</td>
      <td class="mono">${p.memoryCount}</td>
    </tr>`).join('')

  const memoryRows = memories.map(m => `
    <tr>
      <td>${categoryBadge(m.category)}</td>
      <td>${esc(m.title)}</td>
      <td><span class="dim">${esc(m.layer)}</span></td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Orchestrator</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0f0f17;
      --bg-secondary: #16161f;
      --bg-card: #1c1c28;
      --bg-hover: #22222f;
      --border: #2a2a3a;
      --text-primary: #e8e8f0;
      --text-secondary: #8888a0;
      --text-dim: #555568;
      --accent: #7c3aed;
      --accent-light: #a78bfa;
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.12);
      --blue: #3b82f6;
      --blue-bg: rgba(59, 130, 246, 0.12);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --yellow: #eab308;
      --yellow-bg: rgba(234, 179, 8, 0.12);
      --gray: #6b7280;
      --gray-bg: rgba(107, 114, 128, 0.12);
      --teal: #14b8a6;
      --teal-bg: rgba(20, 184, 166, 0.12);
      --purple: #a855f7;
      --purple-bg: rgba(168, 85, 247, 0.12);
      --pink: #ec4899;
      --pink-bg: rgba(236, 72, 153, 0.12);
      --orange: #f97316;
      --orange-bg: rgba(249, 115, 22, 0.12);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 2rem 4rem;
    }

    /* Header */
    .header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    .header h1 {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }
    .header h1 span { color: var(--accent); }
    .header-meta {
      font-size: 0.8rem;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }
    .live-dot {
      display: inline-block;
      width: 6px; height: 6px;
      background: var(--green);
      border-radius: 50%;
      margin-right: 6px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Stats row */
    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-primary);
      line-height: 1;
    }
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 0.25rem;
    }

    /* Sections */
    .section {
      margin-bottom: 2rem;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    .section-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .section-count {
      font-size: 0.75rem;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    /* Tables */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      padding: 0.75rem 1rem;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 0.75rem 1rem;
      font-size: 0.85rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: var(--bg-hover); }
    tr.stale { background: rgba(234, 179, 8, 0.04); }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge-sm { font-size: 0.6rem; padding: 1px 6px; }
    .bg-green { background: var(--green-bg); color: var(--green); }
    .bg-blue { background: var(--blue-bg); color: var(--blue); }
    .bg-red { background: var(--red-bg); color: var(--red); }
    .bg-yellow { background: var(--yellow-bg); color: var(--yellow); }
    .bg-gray { background: var(--gray-bg); color: var(--gray); }
    .bg-teal { background: var(--teal-bg); color: var(--teal); }
    .bg-purple { background: var(--purple-bg); color: var(--purple); }
    .bg-pink { background: var(--pink-bg); color: var(--pink); }
    .bg-orange { background: var(--orange-bg); color: var(--orange); }

    .model-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: var(--accent-light);
    }

    .mono {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
    }
    .dim { color: var(--text-dim); }
    .text-warning { color: var(--yellow); }

    .worker-name { font-weight: 600; }
    .worker-task {
      font-size: 0.75rem;
      color: var(--text-dim);
      margin-top: 2px;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty {
      color: var(--text-dim);
      font-style: italic;
      padding: 2rem;
      text-align: center;
    }

    /* Two-column layout for projects + memory */
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
    }

    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      .grid-2 { grid-template-columns: 1fr; }
      .container { padding: 1rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span>Claude</span> Orchestrator</h1>
      <div class="header-meta"><span class="live-dot"></span>Auto-refreshing</div>
    </div>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-value">${activeWorkers.length}</div>
        <div class="stat-label">Active Workers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${workers.length}</div>
        <div class="stat-label">Total Workers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${projects.length}</div>
        <div class="stat-label">Projects</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalTools.toLocaleString()}</div>
        <div class="stat-label">Total Tool Calls</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">Workers</div>
        <div class="section-count">${workers.length} total</div>
      </div>
      <div class="card">
        ${workers.length > 0 ? `
        <table>
          <tr><th>Worker</th><th>Status</th><th>Model</th><th>Project</th><th>Uptime</th><th>Heartbeat</th><th>Tools</th></tr>
          ${workerRows}
        </table>` : '<p class="empty">No workers spawned yet</p>'}
      </div>
    </div>

    <div class="grid-2">
      <div class="section">
        <div class="section-header">
          <div class="section-title">Projects</div>
          <div class="section-count">${projects.length}</div>
        </div>
        <div class="card">
          ${projects.length > 0 ? `
          <table>
            <tr><th>Project</th><th>Workers</th><th>Memories</th></tr>
            ${projectRows}
          </table>` : '<p class="empty">No projects</p>'}
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <div class="section-title">Memory</div>
          <div class="section-count">${memories.length} entries</div>
        </div>
        <div class="card">
          ${memories.length > 0 ? `
          <table>
            <tr><th>Category</th><th>Title</th><th>Layer</th></tr>
            ${memoryRows}
          </table>` : '<p class="empty">No memories yet</p>'}
        </div>
      </div>
    </div>
  </div>

  <script>
    // Live refresh via fetch instead of full page reload
    setInterval(async () => {
      try {
        const res = await fetch(window.location.href)
        const html = await res.text()
        const parser = new DOMParser()
        const doc = parser.parseFromString(html, 'text/html')
        document.querySelector('.container').innerHTML = doc.querySelector('.container').innerHTML
      } catch {}
    }, 15000)
  </script>
</body>
</html>`
}

export function getWorkersJson(): WorkerData[] { return getWorkers() }
export function getProjectsJson(): ProjectData[] { return getProjects() }
