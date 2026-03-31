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
  try { execSync(`tmux has-session -t "${sessionName}"`, { stdio: 'ignore', timeout: 2000 }); return true } catch { return false }
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
      projects.push({ name, status: workerCount > 0 ? 'active' : 'idle', memoryCount, channelId: info.channelId || null, workerCount, context: (info.context || '').slice(0, 300) })
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

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') }

function estimateCost(toolCount: number, model: string): { tokens: number; cost: number } {
  const tokens = toolCount * 800
  const rates: Record<string, number> = { opus: 0.009, sonnet: 0.0024, haiku: 0.0005 }
  return { tokens, cost: (tokens / 1000) * (rates[model] || rates.sonnet) }
}

function fmtTokens(n: number): string { return n < 1000 ? String(n) : n < 1000000 ? (n / 1000).toFixed(1) + 'k' : (n / 1000000).toFixed(2) + 'M' }
function fmtCost(c: number): string { return c < 0.01 ? '<$0.01' : '$' + c.toFixed(2) }

export function renderDashboard(): string {
  const workers = getWorkers()
  const projects = getProjects()
  const memories = getMemories()
  const active = workers.filter(w => w.status === 'running')
  const totalTools = workers.reduce((s, w) => s + w.toolCount, 0)
  const totalEst = workers.reduce((s, w) => { const e = estimateCost(w.toolCount, w.model); return { tokens: s.tokens + e.tokens, cost: s.cost + e.cost } }, { tokens: 0, cost: 0 })

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { running: '#4DE082', done: '#4D8EFF', error: '#FFB4AB', killed: '#474747', waiting: '#EAB308', starting: '#EAB308' }
    const c = colors[s] || '#474747'
    return `<span class="inline-flex items-center px-2 py-0.5 border border-[${c}] bg-[${c}]/5 text-[${c}] font-mono text-[10px] uppercase">${esc(s)}</span>`
  }

  const memCategoryColor: Record<string, string> = {
    environment: '#4DE082', 'experiment-result': '#4D8EFF', decision: '#D8E2FF',
    preference: '#EC4899', procedure: '#F97316', warning: '#FFB4AB', reference: '#474747'
  }

  return `<!DOCTYPE html>
<html class="dark" lang="en"><head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>ORCHESTRATOR</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"><\/script>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&family=Roboto+Mono&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script>
tailwind.config = {
  darkMode: "class",
  theme: { extend: {
    fontFamily: { headline: ["Space Grotesk"], body: ["Inter"], mono: ["Roboto Mono"] },
    borderRadius: { DEFAULT: "0px", lg: "0px", xl: "0px", full: "0px" },
  }},
}
<\/script>
<style>
.material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24; }
body { background-color: #0A0A0A; color: #E5E2E1; font-family: 'Inter', sans-serif; }
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: #0E0E0E; }
::-webkit-scrollbar-thumb { background: #474747; }
/* Command Palette */
.cmd-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 200; backdrop-filter: blur(4px); justify-content: center; align-items: flex-start; padding-top: 15vh; }
.cmd-overlay.active { display: flex; }
.cmd-modal { background: #131313; border: 1px solid #1C1B1B; width: 560px; max-width: 90vw; }
.cmd-input { width: 100%; background: #0E0E0E; border: none; border-bottom: 1px solid #1C1B1B; padding: 14px 16px; color: #E5E2E1; font-family: 'Roboto Mono', monospace; font-size: 13px; outline: none; }
.cmd-input::placeholder { color: #474747; }
.cmd-output { max-height: 300px; overflow-y: auto; padding: 12px 16px; font-family: 'Roboto Mono', monospace; font-size: 11px; color: #C6C6C6; white-space: pre-wrap; word-break: break-all; }
.cmd-output:empty { display: none; }
.cmd-footer { display: flex; justify-content: space-between; padding: 8px 16px; border-top: 1px solid #1C1B1B; font-family: 'Roboto Mono', monospace; font-size: 9px; color: #474747; text-transform: uppercase; letter-spacing: 0.05em; }
/* Memory Modal */
.mem-modal { width: 640px; max-width: 90vw; }
.mem-header { padding: 12px 16px; font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 12px; border-bottom: 1px solid #1C1B1B; color: #4DE082; text-transform: uppercase; letter-spacing: 0.05em; }
.mem-content { padding: 16px; font-family: 'Roboto Mono', monospace; font-size: 11px; color: #C6C6C6; white-space: pre-wrap; word-break: break-all; line-height: 1.6; max-height: 400px; overflow-y: auto; margin: 0; background: none; }
/* Logs */
.logs-panel { display: none; border: 1px solid #1C1B1B; background: #131313; margin-top: 8px; }
.logs-panel.active { display: block; }
.logs-pre { background: #0E0E0E; padding: 12px; font-family: 'Roboto Mono', monospace; font-size: 11px; color: #C6C6C6; overflow-x: auto; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; margin: 0; }
</style>
</head>
<body class="flex min-h-screen overflow-hidden">

<!-- Sidebar -->
<aside class="fixed left-0 top-0 h-full w-56 border-r border-[#1C1B1B] bg-[#0E0E0E] flex flex-col z-50">
  <div class="p-5">
    <div class="text-lg font-bold tracking-tighter text-white font-headline">ORCHESTRATOR</div>
    <div class="font-headline uppercase tracking-[0.05rem] text-[10px] text-[#4DE082] mt-0.5">SYSTEM MONITOR</div>
  </div>
  <nav class="flex-1 mt-2">
    <a class="flex items-center gap-3 px-5 py-2.5 text-[#4DE082] border-l-2 border-[#4DE082] bg-[#1C1B1B] font-headline uppercase tracking-[0.05rem] text-xs" href="#">
      <span class="material-symbols-outlined text-base">dashboard</span>DASHBOARD
    </a>
    <a class="flex items-center gap-3 px-5 py-2.5 text-[#C6C6C6] font-headline uppercase tracking-[0.05rem] text-xs hover:bg-[#1C1B1B] hover:text-white" href="#">
      <span class="material-symbols-outlined text-base">account_tree</span>PROJECTS
    </a>
    <a class="flex items-center gap-3 px-5 py-2.5 text-[#C6C6C6] font-headline uppercase tracking-[0.05rem] text-xs hover:bg-[#1C1B1B] hover:text-white" href="#">
      <span class="material-symbols-outlined text-base">engineering</span>WORKERS
    </a>
    <a class="flex items-center gap-3 px-5 py-2.5 text-[#C6C6C6] font-headline uppercase tracking-[0.05rem] text-xs hover:bg-[#1C1B1B] hover:text-white" href="#">
      <span class="material-symbols-outlined text-base">memory</span>MEMORY
    </a>
  </nav>
  <div class="border-t border-[#1C1B1B] py-3">
    <a class="flex items-center gap-3 px-5 py-2 text-[#C6C6C6] font-headline uppercase tracking-[0.05rem] text-xs hover:bg-[#1C1B1B]" onclick="openPalette()" href="#" style="cursor:pointer">
      <span class="material-symbols-outlined text-base">terminal</span>COMMAND (&#8984;K)
    </a>
  </div>
</aside>

<!-- Main -->
<main class="flex-1 ml-56 min-h-screen flex flex-col bg-[#0A0A0A]">
  <!-- Header -->
  <header class="h-14 border-b border-[#1C1B1B] bg-[#131313] flex justify-between items-center px-6 sticky top-0 z-40">
    <div class="text-sm font-bold text-white font-headline tracking-tighter uppercase">System Monitor</div>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2 px-2.5 py-1 border border-[#4DE082] bg-[#4DE082]/10">
        <div class="w-1.5 h-1.5 bg-[#4DE082] animate-pulse"></div>
        <span class="font-headline text-[9px] tracking-widest text-[#4DE082] uppercase">Online</span>
      </div>
      <span class="material-symbols-outlined text-[#C6C6C6] cursor-pointer hover:text-white text-lg" onclick="openPalette()">terminal</span>
    </div>
  </header>

  <div class="p-6 space-y-6 overflow-y-auto h-[calc(100vh-3.5rem)]">
    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-6 gap-0 border border-[#1C1B1B]">
      <div class="bg-[#131313] p-5 border-r border-[#1C1B1B] relative overflow-hidden">
        <div class="text-[#C6C6C6] font-headline text-[9px] tracking-widest uppercase mb-3">Active Workers</div>
        <div class="flex items-baseline gap-2">
          <span class="text-3xl font-headline font-bold text-white tracking-tighter">${active.length}</span>
          <span class="text-[#4DE082] font-mono text-[10px]">/ ${workers.length}</span>
        </div>
        <div class="absolute bottom-0 left-0 w-full h-0.5 bg-[#4DE082]/20"><div class="h-full bg-[#4DE082]" style="width:${workers.length ? Math.round(active.length / workers.length * 100) : 0}%"></div></div>
      </div>
      <div class="bg-[#131313] p-5 border-r border-[#1C1B1B]">
        <div class="text-[#C6C6C6] font-headline text-[9px] tracking-widest uppercase mb-3">Projects</div>
        <div class="text-3xl font-headline font-bold text-white tracking-tighter">${projects.length}</div>
      </div>
      <div class="bg-[#131313] p-5 border-r border-[#1C1B1B]">
        <div class="text-[#C6C6C6] font-headline text-[9px] tracking-widest uppercase mb-3">Memories</div>
        <div class="text-3xl font-headline font-bold text-white tracking-tighter">${memories.length}</div>
      </div>
      <div class="bg-[#131313] p-5 border-r border-[#1C1B1B]">
        <div class="text-[#C6C6C6] font-headline text-[9px] tracking-widest uppercase mb-3">Tool Calls</div>
        <div class="text-3xl font-headline font-bold text-white tracking-tighter">${totalTools.toLocaleString()}</div>
      </div>
      <div class="bg-[#131313] p-5 border-r border-[#1C1B1B]">
        <div class="text-[#C6C6C6] font-headline text-[9px] tracking-widest uppercase mb-3">Est. Tokens</div>
        <div class="text-3xl font-headline font-bold text-white tracking-tighter">${fmtTokens(totalEst.tokens)}</div>
      </div>
      <div class="bg-[#131313] p-5">
        <div class="text-[#C6C6C6] font-headline text-[9px] tracking-widest uppercase mb-3">Est. Cost</div>
        <div class="text-3xl font-headline font-bold ${totalEst.cost < 1 ? 'text-[#4DE082]' : totalEst.cost < 5 ? 'text-[#EAB308]' : 'text-[#FFB4AB]'} tracking-tighter">${fmtCost(totalEst.cost)}</div>
      </div>
    </div>

    <!-- Main Grid -->
    <div class="grid grid-cols-12 gap-6">
      <!-- Workers -->
      <div class="col-span-12 lg:col-span-8 space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="font-headline font-bold text-base text-white tracking-tight uppercase">Workers</h2>
        </div>
        <div class="border border-[#1C1B1B] bg-[#131313]">
          ${workers.length > 0 ? `<table class="w-full text-left border-collapse">
            <thead><tr class="bg-[#1C1B1B]">
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Worker</th>
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Status</th>
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Model</th>
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Project</th>
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Heartbeat</th>
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Cost</th>
              <th class="p-3 font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase text-right">Action</th>
            </tr></thead>
            <tbody class="divide-y divide-[#1C1B1B]/50">
              ${workers.map(w => {
                const est = estimateCost(w.toolCount, w.model)
                const stale = w.status === 'running' && w.heartbeatAge > 600
                return `<tr class="${stale ? 'bg-[#EAB308]/5' : ''}">
                  <td class="p-3"><div class="font-mono text-sm text-white">${esc(w.name)}</div>${w.task ? `<div class="text-[10px] text-[#474747] font-mono mt-0.5 truncate max-w-[240px]">${esc(w.task)}</div>` : ''}</td>
                  <td class="p-3">${statusBadge(w.status)}${!w.tmuxAlive && w.status === 'running' ? ' <span class="inline-flex items-center px-1.5 py-0.5 border border-[#FFB4AB] bg-[#FFB4AB]/5 text-[#FFB4AB] font-mono text-[9px] uppercase ml-1">DEAD</span>' : ''}</td>
                  <td class="p-3 font-mono text-xs text-[#C6C6C6]">${esc(w.model)}</td>
                  <td class="p-3 font-mono text-xs ${w.project ? 'text-[#C6C6C6]' : 'text-[#474747]'}">${w.project ? esc(w.project) : '-'}</td>
                  <td class="p-3 font-mono text-[10px] ${stale ? 'text-[#EAB308]' : 'text-[#C6C6C6]'}">${esc(w.heartbeat)}</td>
                  <td class="p-3 font-mono text-[10px] ${est.cost < 1 ? 'text-[#4DE082]' : est.cost < 5 ? 'text-[#EAB308]' : 'text-[#FFB4AB]'}">${fmtCost(est.cost)}</td>
                  <td class="p-3 text-right">${w.tmuxAlive ? `<button onclick="showLogs('${esc(w.name)}')" class="text-[#4DE082] font-headline text-[10px] font-bold tracking-widest hover:underline">VIEW_LOGS</button>` : '<span class="text-[#474747] font-headline text-[10px]">OFFLINE</span>'}</td>
                </tr>`
              }).join('')}
            </tbody>
          </table>` : '<div class="p-8 text-center text-[#474747] font-mono text-xs uppercase">No workers spawned</div>'}
        </div>
        <div id="logs-panel" class="logs-panel">
          <div class="flex items-center justify-between px-4 py-2 bg-[#1C1B1B]">
            <span class="font-headline text-[10px] tracking-widest text-[#C6C6C6] uppercase" id="logs-title">Logs</span>
            <button onclick="document.getElementById('logs-panel').classList.remove('active')" class="text-[#474747] hover:text-white material-symbols-outlined text-sm">close</button>
          </div>
          <pre class="logs-pre" id="logs-content">Loading...</pre>
        </div>
      </div>

      <!-- Projects -->
      <div class="col-span-12 lg:col-span-4 space-y-3">
        <h2 class="font-headline font-bold text-base text-white tracking-tight uppercase">Projects</h2>
        <div class="border border-[#1C1B1B] bg-[#131313]">
          <div class="bg-[#1C1B1B] px-4 py-2.5"><div class="font-headline text-[9px] tracking-widest text-[#C6C6C6] uppercase">Project Registry</div></div>
          ${projects.length > 0 ? `<div class="divide-y divide-[#1C1B1B]">
            ${projects.map(p => `<div class="p-4 flex justify-between items-center hover:bg-[#1C1B1B]/40">
              <div>
                <div class="font-mono text-sm ${p.status === 'active' ? 'text-[#4DE082]' : 'text-white'}">${esc(p.name)}</div>
                <div class="text-[10px] text-[#474747] font-mono uppercase mt-0.5">Status: ${esc(p.status)}</div>
              </div>
              <div class="text-right">
                <div class="text-xs ${p.workerCount > 0 ? 'text-white' : 'text-[#474747]'} font-mono">${p.workerCount} WORKER${p.workerCount !== 1 ? 'S' : ''}</div>
                <div class="text-[10px] text-[#474747] font-mono uppercase">${p.memoryCount} MEMOR${p.memoryCount !== 1 ? 'IES' : 'Y'}</div>
              </div>
            </div>`).join('')}
          </div>` : '<div class="p-6 text-center text-[#474747] font-mono text-xs uppercase">No projects</div>'}
        </div>
      </div>

      <!-- Memory Feed -->
      <div class="col-span-12 lg:col-span-8 space-y-3">
        <h2 class="font-headline font-bold text-base text-white tracking-tight uppercase">Memory Feed</h2>
        ${memories.length > 0 ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${memories.map(m => {
            const c = memCategoryColor[m.category] || '#474747'
            return `<div class="bg-[#1C1B1B] p-4 border-l-4 cursor-pointer hover:bg-[#222] flex flex-col justify-between min-h-[120px]" style="border-left-color:${c}" onclick="showMemory('${esc(m.layer)}','${esc(m.id)}')">
              <div>
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-[9px] font-mono px-1.5 py-0.5 uppercase tracking-tighter" style="background:${c}15;color:${c}">${esc(m.category)}</span>
                  <span class="text-[#474747] text-[9px] font-mono uppercase">Layer: ${esc(m.layer)}</span>
                </div>
                <h3 class="text-white font-body text-sm leading-relaxed">${esc(m.title)}</h3>
              </div>
            </div>`
          }).join('')}
        </div>` : '<div class="border border-[#1C1B1B] bg-[#131313] p-6 text-center text-[#474747] font-mono text-xs uppercase">No memories stored</div>'}
      </div>

      <!-- System Log -->
      <div class="col-span-12 lg:col-span-4 space-y-3">
        <h2 class="font-headline font-bold text-base text-white tracking-tight uppercase">System Log</h2>
        <div class="relative border-l border-[#1C1B1B] ml-2 pl-5 space-y-5 py-1" id="notif-timeline">
          <div class="text-[#474747] font-mono text-[10px] uppercase">Loading...</div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="pt-3 border-t border-[#1C1B1B] flex justify-between items-center font-mono text-[10px] text-[#474747]">
      <div class="flex gap-5">
        <span>WORKERS: ${workers.length}</span>
        <span>MEMORIES: ${memories.length}</span>
        <span>PORT: 9111</span>
      </div>
      <div class="flex gap-4">
        <span class="text-[#4DE082]">&#9679; ORCHESTRATOR ONLINE</span>
      </div>
    </footer>
  </div>
</main>

<!-- Command Palette -->
<div id="cmd-overlay" class="cmd-overlay" onclick="if(event.target===this)closePalette()">
  <div class="cmd-modal">
    <input id="cmd-input" class="cmd-input" type="text" placeholder="> ENTER COMMAND..." autofocus>
    <div id="cmd-output" class="cmd-output"></div>
    <div class="cmd-footer"><span>ENTER TO EXECUTE</span><span>ESC TO CLOSE</span></div>
  </div>
</div>

<!-- Memory Modal -->
<div id="mem-overlay" class="cmd-overlay" onclick="if(event.target===this)closeMemory()">
  <div class="cmd-modal mem-modal">
    <div class="mem-header" id="mem-header">Memory</div>
    <pre class="mem-content" id="mem-content">Loading...</pre>
    <div class="cmd-footer"><span>ESC TO CLOSE</span><span></span></div>
  </div>
</div>

<script>
// Logs
async function showLogs(n) {
  const p = document.getElementById('logs-panel'); p.classList.add('active')
  document.getElementById('logs-title').textContent = 'LOGS: ' + n.toUpperCase()
  document.getElementById('logs-content').textContent = 'Loading...'
  try { const d = await (await fetch('/api/logs/'+n)).json(); document.getElementById('logs-content').textContent = d.logs||'(empty)' }
  catch(e) { document.getElementById('logs-content').textContent = 'Error: '+e.message }
}

// Notifications
async function loadNotifs() {
  try {
    const data = await (await fetch('/api/notifications')).json()
    const el = document.getElementById('notif-timeline')
    if (!data.length) { el.innerHTML = '<div class="text-[#474747] font-mono text-[10px] uppercase">No activity</div>'; return }
    const colors = { done:'#4DE082', update:'#C6C6C6', error:'#FFB4AB', blocked:'#EAB308' }
    el.innerHTML = data.slice(0,10).map(n => {
      const t = new Date(n.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
      const c = colors[n.event]||'#C6C6C6'
      return '<div class="relative"><div class="absolute -left-[26px] top-1 w-2 h-2 border-2 border-[#0A0A0A]" style="background:'+c+'"></div><div class="flex justify-between"><span class="font-mono text-[10px] uppercase" style="color:'+c+'">'+n.event+'</span><span class="font-mono text-[10px] text-[#474747]">'+t+'</span></div><p class="text-xs text-[#C6C6C6] mt-0.5 font-body">'+n.worker+': '+n.summary.slice(0,80)+'</p></div>'
    }).join('')
  } catch {}
}
loadNotifs()

// Command Palette
function openPalette() { document.getElementById('cmd-overlay').classList.add('active'); const i=document.getElementById('cmd-input'); i.focus(); i.value='' }
function closePalette() { document.getElementById('cmd-overlay').classList.remove('active') }
document.addEventListener('keydown', e => {
  if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); openPalette() }
  if (e.key==='Escape') { closePalette(); closeMemory() }
})
document.getElementById('cmd-input').addEventListener('keydown', async e => {
  if (e.key!=='Enter') return
  const cmd = e.target.value.trim(); if (!cmd) return
  const out = document.getElementById('cmd-output'); out.textContent = 'Executing...'
  try {
    const d = await (await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:cmd})})).json()
    out.textContent = d.output||(d.exitCode===0?'(ok)':'(error)')
  } catch(err) { out.textContent='Error: '+err.message }
})

// Memory
async function showMemory(layer, id) {
  document.getElementById('mem-overlay').classList.add('active')
  document.getElementById('mem-header').textContent = (layer+':'+id).toUpperCase()
  document.getElementById('mem-content').textContent = 'Loading...'
  try { const d = await (await fetch('/api/memory/'+layer+'/'+id)).json(); document.getElementById('mem-content').textContent = d.content||'(empty)' }
  catch(e) { document.getElementById('mem-content').textContent = 'Error: '+e.message }
}
function closeMemory() { document.getElementById('mem-overlay').classList.remove('active') }

// Auto-refresh
setInterval(async () => {
  try {
    const r = await fetch(window.location.href); const h = await r.text()
    const p = new DOMParser(); const d = p.parseFromString(h,'text/html')
    const la = document.getElementById('logs-panel')?.classList.contains('active')
    const lc = document.getElementById('logs-content')?.textContent
    const lt = document.getElementById('logs-title')?.textContent
    const ss = d.querySelectorAll('.grid-cols-6 > div')
    const ts = document.querySelectorAll('.grid-cols-6 > div')
    ss.forEach((s,i) => { if(ts[i]) ts[i].innerHTML = s.innerHTML })
    if (la) { document.getElementById('logs-panel').classList.add('active'); document.getElementById('logs-content').textContent=lc; document.getElementById('logs-title').textContent=lt }
    loadNotifs()
  } catch {}
}, 10000)
<\/script>
</body></html>`
}

export function getWorkersJson(): WorkerData[] { return getWorkers() }
export function getProjectsJson(): ProjectData[] { return getProjects() }
