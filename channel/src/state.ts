import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface ProjectInfo {
  name: string
  channelId: string
  contextMessageId: string
  context: string
}

export interface WorkerInfo {
  name: string
  projectName: string | null
  threadId: string
  statusMessageId: string
}

export interface ChannelState {
  mainChannelId: string
  notificationsChannelId: string
  tasksChannelId: string
  projects: Record<string, ProjectInfo>
  workers: Record<string, WorkerInfo>
}

const ORCH_HOME = process.env.ORCH_HOME || join(process.env.HOME || '', '.claude-orchestrator')
const STATE_FILE = join(ORCH_HOME, 'channel-state.json')

function defaultState(): ChannelState {
  return {
    mainChannelId: '',
    notificationsChannelId: '',
    tasksChannelId: '',
    projects: {},
    workers: {},
  }
}

export function loadState(): ChannelState {
  if (!existsSync(STATE_FILE)) {
    const configPath = join(ORCH_HOME, 'config.json')
    const state = defaultState()
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        if (config.discord) {
          state.mainChannelId = config.discord.main_channel_id || ''
          state.notificationsChannelId = config.discord.notifications_channel_id || ''
          state.tasksChannelId = config.discord.tasks_channel_id || ''
        }
      } catch {
        // ignore parse errors
      }
    }
    return state
  }

  try {
    const raw = readFileSync(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    return { ...defaultState(), ...parsed }
  } catch {
    return defaultState()
  }
}

export function saveState(state: ChannelState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export function getWorkerByThreadId(state: ChannelState, threadId: string): WorkerInfo | undefined {
  return Object.values(state.workers).find(w => w.threadId === threadId)
}

export function getProjectByChannelId(state: ChannelState, channelId: string): ProjectInfo | undefined {
  return Object.values(state.projects).find(p => p.channelId === channelId)
}

export function addWorker(state: ChannelState, worker: WorkerInfo): void {
  state.workers[worker.name] = worker
  saveState(state)
}

export function removeWorker(state: ChannelState, workerName: string): void {
  delete state.workers[workerName]
  saveState(state)
}

export function addProject(state: ChannelState, project: ProjectInfo): void {
  state.projects[project.name] = project
  saveState(state)
}
