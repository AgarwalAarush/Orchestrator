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
  context: string
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
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const statusFile = join(dir, 'status')
    if (!existsSync(statusFile)) continue
    const status = readFileSync(statusFile, 'utf-8').trim()
    let model = '?', project: string | null = null, created = ''
    try { const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')); model = m.model || '?'; project = m.project || null; created = m.created || '' } catch {}
    let heartbeat = '-', heartbeatAge = 999999
    try { const hb = parseInt(readFileSync(join(dir, 'heartbeat'), 'utf-8').trim(), 10); heartbeatAge = now - hb; heartbeat = humanDuration(heartbeatAge) + ' ago' } catch {}
    let uptime = '-'
    if (created) { try { uptime = humanDuration(Math.floor((Date.now() - new Date(created).getTime()) / 1000)) } catch {} }
    let toolCount = 0
    try { toolCount = parseInt(readFileSync(join(dir, 'tool_count'), 'utf-8').trim(), 10) || 0 } catch {}
    let task = ''
    try { task = readFileSync(join(dir, 'task'), 'utf-8').trim().slice(0, 120) } catch {}
    workers.push({ name, status, model, project, uptime, heartbeat, heartbeatAge, toolCount, tmuxAlive: tmuxAlive(`orch-${name}`), task })
  }
  workers.sort((a, b) => { if (a.status === 'running' && b.status !== 'running') return -1; if (b.status === 'running' && a.status !== 'running') return 1; return a.name.localeCompare(b.name) })
  return workers
}

function getProjects(): ProjectData[] {
  const stateFile = join(ORCH_HOME, 'channel-state.json')
  const projects: ProjectData[] = []
  let state: any = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')) } catch {}
  if (state.projects) {
    for (const [name, info] of Object.entries(state.projects) as any) {
      let memoryCount = 0
      const memDir = join(ORCH_HOME, 'projects', name, 'memory')
      if (existsSync(memDir)) memoryCount = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== '_index.md').length
      let workerCount = 0
      const workersDir = join(ORCH_HOME, 'workers')
      if (existsSync(workersDir)) {
        for (const w of readdirSync(workersDir)) {
          try { const m = JSON.parse(readFileSync(join(workersDir, w, 'meta.json'), 'utf-8')); if (m.project === name) workerCount++ } catch {}
        }
      }
      projects.push({ name, status: 'active', memoryCount, channelId: info.channelId || null, workerCount, context: (info.context || '').slice(0, 300) })
    }
  }
  return projects
}

function getMemories(): MemoryData[] {
  const memories: MemoryData[] = []
  const scan = (dir: string, layer: string) => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md') && f !== '_index.md')) {
      try {
        const c = readFileSync(join(dir, f), 'utf-8')
        memories.push({ layer, id: f.replace('.md', ''), title: c.match(/^title:\s*(.+)$/m)?.[1] || f.replace('.md', ''), category: c.match(/^category:\s*(.+)$/m)?.[1] || 'reference' })
      } catch {}
    }
  }
  scan(join(ORCH_HOME, 'memory', 'user'), 'user')
  if (existsSync(join(ORCH_HOME, 'projects'))) {
    for (const p of readdirSync(join(ORCH_HOME, 'projects'))) {
      scan(join(ORCH_HOME, 'projects', p, 'memory'), p)
    }
  }
  return memories
}

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

// Estimate cost per tool call by model (input + output tokens, rough avg)
function estimateCost(toolCount: number, model: string): { tokens: number; cost: number } {
  const tokensPerCall = 800 // avg tokens per tool call round-trip
  const tokens = toolCount * tokensPerCall
  // $/M tokens: input + output blended rate
  const rates: Record<string, number> = {
    opus: 0.009, // ~$9/M blended
    sonnet: 0.0024, // ~$2.40/M blended
    haiku: 0.0005, // ~$0.50/M blended
  }
  const rate = rates[model] || rates.sonnet
  return { tokens, cost: (tokens / 1000) * rate }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1000000).toFixed(2) + 'M'
}

function formatCost(c: number): string {
  if (c < 0.01) return '<$0.01'
  return '$' + c.toFixed(2)
}

function costClass(c: number): string {
  if (c < 1) return 'green'
  if (c < 5) return 'yellow'
  return 'red'
}

export function renderDashboard(): string {
  const workers = getWorkers()
  const projects = getProjects()
  const memories = getMemories()
  const active = workers.filter(w => w.status === 'running')
  const totalTools = workers.reduce((s, w) => s + w.toolCount, 0)
  const totalEst = workers.reduce((s, w) => { const e = estimateCost(w.toolCount, w.model); return { tokens: s.tokens + e.tokens, cost: s.cost + e.cost } }, { tokens: 0, cost: 0 })

  const badge = (s: string, cls: string) => `<span class="badge ${cls}">${esc(s)}</span>`
  const statusBadge = (s: string) => {
    const m: Record<string, string> = { running: 'green', done: 'blue', error: 'red', killed: 'gray', waiting: 'yellow', starting: 'yellow' }
    return badge(s, m[s] || 'gray')
  }
  const catBadge = (c: string) => {
    const m: Record<string, string> = { environment: 'teal', 'experiment-result': 'purple', decision: 'blue', preference: 'pink', procedure: 'orange', warning: 'red', reference: 'gray' }
    return `<span class="badge sm ${m[c] || 'gray'}">${esc(c)}</span>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orchestrator</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg-0: #0c0c14; --bg-1: #12121c; --bg-2: #1a1a26; --bg-3: #222230;
  --border: #2a2a3c; --text-0: #f0f0f8; --text-1: #b0b0c0; --text-2: #666680;
  --accent: #7c3aed; --accent-l: #a78bfa;
  --green: #22c55e; --blue: #3b82f6; --red: #ef4444; --yellow: #eab308;
  --gray: #6b7280; --teal: #14b8a6; --purple: #a855f7; --pink: #ec4899; --orange: #f97316;
}
.light {
  --bg-0: #fafafa; --bg-1: #ffffff; --bg-2: #f4f4f5; --bg-3: #e8e8ec;
  --border: #e0e0e8; --text-0: #111118; --text-1: #555560; --text-2: #999;
  --accent: #7c3aed; --accent-l: #6d28d9;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', sans-serif; background: var(--bg-0); color: var(--text-0); -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 1.5rem 2rem 4rem; }
.hdr { display: flex; align-items: center; justify-content: space-between; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem; }
.hdr h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.03em; }
.hdr h1 b { color: var(--accent); }
.hdr-r { display: flex; align-items: center; gap: 1rem; }
.live { font-size: 0.7rem; color: var(--text-2); font-family: 'JetBrains Mono', monospace; display: flex; align-items: center; gap: 6px; }
.dot { width: 6px; height: 6px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
.theme-btn { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; color: var(--text-1); cursor: pointer; font-size: 0.75rem; font-family: 'Inter', sans-serif; }
.theme-btn:hover { background: var(--bg-3); }

.stats { display: grid; grid-template-columns: repeat(6,1fr); gap: .75rem; margin-bottom: 1.5rem; }
.stat { background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
.stat-v { font-size: 1.75rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; line-height: 1; }
.stat-l { font-size: .65rem; color: var(--text-2); text-transform: uppercase; letter-spacing: .06em; margin-top: .2rem; }

.sec { margin-bottom: 1.5rem; }
.sec-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: .5rem; }
.sec-t { font-size: .75rem; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .06em; }
.sec-c { font-size: .7rem; color: var(--text-2); font-family: 'JetBrains Mono', monospace; }

.card { background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: .6rem .85rem; font-size: .6rem; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .06em; background: var(--bg-2); border-bottom: 1px solid var(--border); }
td { padding: .6rem .85rem; font-size: .8rem; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr:hover { background: var(--bg-2); }
tr.stale { background: rgba(234,179,8,.05); }

.badge { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: .65rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
.badge.sm { font-size: .55rem; padding: 1px 6px; }
.green { background: rgba(34,197,94,.12); color: var(--green); }
.blue { background: rgba(59,130,246,.12); color: var(--blue); }
.red { background: rgba(239,68,68,.12); color: var(--red); }
.yellow { background: rgba(234,179,8,.12); color: var(--yellow); }
.gray { background: rgba(107,114,128,.12); color: var(--gray); }
.teal { background: rgba(20,184,166,.12); color: var(--teal); }
.purple { background: rgba(168,85,247,.12); color: var(--purple); }
.pink { background: rgba(236,72,153,.12); color: var(--pink); }
.orange { background: rgba(249,115,22,.12); color: var(--orange); }

.mono { font-family: 'JetBrains Mono', monospace; font-size: .75rem; }
.dim { color: var(--text-2); }
.w-name { font-weight: 600; }
.w-task { font-size: .7rem; color: var(--text-2); margin-top: 2px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model { font-family: 'JetBrains Mono', monospace; font-size: .7rem; color: var(--accent-l); }
.empty { color: var(--text-2); font-style: italic; padding: 1.5rem; text-align: center; font-size: .85rem; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }

/* Logs panel */
.logs-panel { display: none; background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; margin-top: .5rem; }
.logs-panel.active { display: block; }
.logs-pre { background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: .75rem; font-family: 'JetBrains Mono', monospace; font-size: .7rem; color: var(--text-1); overflow-x: auto; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
.logs-title { font-size: .75rem; font-weight: 600; margin-bottom: .5rem; color: var(--text-1); }

.btn { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; color: var(--text-1); cursor: pointer; font-size: .65rem; font-family: 'Inter', sans-serif; }
.btn:hover { background: var(--bg-3); color: var(--text-0); }
.btn-sm { padding: 2px 7px; font-size: .6rem; }

/* Notification feed */
.notif-item { padding: .5rem .85rem; border-bottom: 1px solid var(--border); font-size: .8rem; display: flex; gap: .75rem; align-items: baseline; }
.notif-item:last-child { border-bottom: none; }
.notif-time { font-family: 'JetBrains Mono', monospace; font-size: .6rem; color: var(--text-2); white-space: nowrap; }
.notif-text { flex: 1; }

@media (max-width: 900px) { .stats{grid-template-columns:repeat(3,1fr)} .grid-2,.grid-3{grid-template-columns:1fr} .wrap{padding:1rem} }
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1><b>Claude</b> Orchestrator</h1>
    <div class="hdr-r">
      <div class="live"><span class="dot"></span> Live</div>
      <button class="theme-btn" onclick="toggleTheme()">Toggle theme</button>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-v">${active.length}</div><div class="stat-l">Active Workers</div></div>
    <div class="stat"><div class="stat-v">${workers.length}</div><div class="stat-l">Total Workers</div></div>
    <div class="stat"><div class="stat-v">${projects.length}</div><div class="stat-l">Projects</div></div>
    <div class="stat"><div class="stat-v">${totalTools.toLocaleString()}</div><div class="stat-l">Tool Calls</div></div>
    <div class="stat"><div class="stat-v">${formatTokens(totalEst.tokens)}</div><div class="stat-l">Est. Tokens</div></div>
    <div class="stat"><div class="stat-v"><span class="${costClass(totalEst.cost)}">${formatCost(totalEst.cost)}</span></div><div class="stat-l">Est. Cost</div></div>
  </div>

  <div class="sec">
    <div class="sec-h"><div class="sec-t">Workers</div><div class="sec-c">${workers.length}</div></div>
    <div class="card">
      ${workers.length > 0 ? `<table>
        <tr><th>Worker</th><th>Status</th><th>Model</th><th>Project</th><th>Uptime</th><th>Heartbeat</th><th>Tools</th><th>Est. Cost</th><th></th></tr>
        ${workers.map(w => {
          const stale = w.status === 'running' && w.heartbeatAge > 600
          const est = estimateCost(w.toolCount, w.model)
          return `<tr${stale ? ' class="stale"' : ''}>
            <td><div class="w-name">${esc(w.name)}</div>${w.task ? `<div class="w-task">${esc(w.task)}</div>` : ''}</td>
            <td>${statusBadge(w.status)}${!w.tmuxAlive && w.status === 'running' ? ' ' + badge('tmux dead', 'red sm') : ''}</td>
            <td><span class="model">${esc(w.model)}</span></td>
            <td>${w.project ? esc(w.project) : '<span class="dim">-</span>'}</td>
            <td class="mono">${esc(w.uptime)}</td>
            <td class="mono${stale ? ' dim' : ''}">${esc(w.heartbeat)}</td>
            <td class="mono">${w.toolCount.toLocaleString()}</td>
            <td class="mono"><span class="${costClass(est.cost)}">${formatCost(est.cost)}</span></td>
            <td>${w.tmuxAlive ? `<button class="btn btn-sm" onclick="showLogs('${esc(w.name)}')">Logs</button>` : ''}</td>
          </tr>`
        }).join('')}
      </table>` : '<p class="empty">No workers spawned yet</p>'}
    </div>
    <div id="logs-panel" class="logs-panel">
      <div class="logs-title" id="logs-title">Logs</div>
      <pre class="logs-pre" id="logs-content">Loading...</pre>
    </div>
  </div>

  <div class="grid-3">
    <div class="sec">
      <div class="sec-h"><div class="sec-t">Projects</div><div class="sec-c">${projects.length}</div></div>
      <div class="card">
        ${projects.length > 0 ? `<table>
          <tr><th>Project</th><th>Workers</th><th>Memories</th></tr>
          ${projects.map(p => `<tr>
            <td><strong>${esc(p.name)}</strong></td>
            <td class="mono">${p.workerCount}</td>
            <td class="mono">${p.memoryCount}</td>
          </tr>`).join('')}
        </table>` : '<p class="empty">No projects</p>'}
      </div>
    </div>

    <div class="sec">
      <div class="sec-h"><div class="sec-t">Memory</div><div class="sec-c">${memories.length} entries</div></div>
      <div class="card">
        ${memories.length > 0 ? `<table>
          <tr><th>Cat</th><th>Title</th><th>Layer</th></tr>
          ${memories.map(m => `<tr>
            <td>${catBadge(m.category)}</td>
            <td>${esc(m.title)}</td>
            <td><span class="dim">${esc(m.layer)}</span></td>
          </tr>`).join('')}
        </table>` : '<p class="empty">No memories</p>'}
      </div>
    </div>

    <div class="sec">
      <div class="sec-h"><div class="sec-t">Recent Notifications</div></div>
      <div class="card" id="notif-card">
        <p class="empty" id="notif-empty">Loading...</p>
      </div>
    </div>
  </div>
</div>

<script>
function toggleTheme() {
  document.body.classList.toggle('light')
  localStorage.setItem('theme', document.body.classList.contains('light') ? 'light' : 'dark')
}
if (localStorage.getItem('theme') === 'light') document.body.classList.add('light')

async function showLogs(name) {
  const panel = document.getElementById('logs-panel')
  const title = document.getElementById('logs-title')
  const content = document.getElementById('logs-content')
  panel.classList.add('active')
  title.textContent = 'Logs: ' + name
  content.textContent = 'Loading...'
  try {
    const res = await fetch('/api/logs/' + name)
    const data = await res.json()
    content.textContent = data.logs || '(empty)'
  } catch (e) {
    content.textContent = 'Error: ' + e.message
  }
}

async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications')
    const data = await res.json()
    const card = document.getElementById('notif-card')
    if (data.length === 0) {
      card.innerHTML = '<p class="empty">No notifications yet</p>'
      return
    }
    const emojis = { done: '\\u2705', update: '\\uD83D\\uDCCB', error: '\\u274C', blocked: '\\uD83D\\uDEAB' }
    card.innerHTML = data.slice(0, 15).map(n => {
      const time = new Date(n.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
      const emoji = emojis[n.event] || '\\uD83D\\uDCCB'
      return '<div class="notif-item"><span class="notif-time">' + time + '</span><span class="notif-text">' + emoji + ' <strong>' + n.worker + '</strong> ' + n.summary.slice(0, 100) + '</span></div>'
    }).join('')
  } catch {}
}
loadNotifications()

// Refresh data every 10s
setInterval(async () => {
  try {
    const res = await fetch(window.location.href)
    const html = await res.text()
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    // Preserve logs panel state
    const logsActive = document.getElementById('logs-panel')?.classList.contains('active')
    const logsContent = document.getElementById('logs-content')?.textContent
    const logsTitle = document.getElementById('logs-title')?.textContent
    // Update main content
    document.querySelector('.stats').innerHTML = doc.querySelector('.stats').innerHTML
    document.querySelectorAll('.sec .card')[0].innerHTML = doc.querySelectorAll('.sec .card')[0].innerHTML
    // Restore logs if open
    if (logsActive) {
      document.getElementById('logs-panel').classList.add('active')
      document.getElementById('logs-content').textContent = logsContent
      document.getElementById('logs-title').textContent = logsTitle
    }
    loadNotifications()
  } catch {}
}, 10000)
</script>
</body>
</html>`
}

export function getWorkersJson(): WorkerData[] { return getWorkers() }
export function getProjectsJson(): ProjectData[] { return getProjects() }
