import { adapterStateDir, generatedPaths, INJECT_ENV } from './launch-env.ts'
// Adapter-local readiness is stronger than thread membership: computed startup context
// must have been emitted for this run before ordinary work is admitted. "Emitted" is a
// delivery attempt, not an acknowledgement from Codex or proof the model read it.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acquireFileLock } from './file-lock.ts'

export interface StartupIdentity { session: string; workspace: string; handle: string }
interface StartupRecord extends StartupIdentity {
  version: 1
  generation: string
  status: 'pending' | 'context-emitted'
  replayPending: boolean
  daemon?: string
  payload: Record<string, unknown>
}
export interface StartupDelivery {
  identity: StartupIdentity
  generation: string
  context: string
  required: boolean
}
function pathFor(identity: StartupIdentity): string {
  if (!adapterStateDir() || !identity.session || !identity.handle) throw new Error('Startup readiness requires a workspace and registered thread.')
  return join(adapterStateDir()!, 'startup', `${createHash('sha256').update(identity.session).digest('hex')}.json`)
}
function write(record: StartupRecord): void {
  const file = pathFor(record)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
  renameSync(temporary, file)
}
function read(identity: StartupIdentity): StartupRecord | undefined {
  let record: StartupRecord
  try { record = JSON.parse(readFileSync(pathFor(identity), 'utf8')) as StartupRecord }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Unreadable Codex startup readiness record.') }
  if (!record || record.version !== 1 || record.session !== identity.session || record.workspace !== resolve(identity.workspace) || record.handle !== identity.handle ||
      typeof record.generation !== 'string' || !['pending', 'context-emitted'].includes(record.status) || typeof record.replayPending !== 'boolean' || !record.payload || typeof record.payload !== 'object') {
    throw new Error('Codex startup readiness belongs to a different launch or is malformed.')
  }
  return record
}

/** A new daemon must receive inert history replay before any live transcript capture. */
export function isStartupReady(identity: StartupIdentity, daemon: string): boolean {
  const record = read(identity)
  return record?.status === 'context-emitted' && !record.replayPending && record.daemon === daemon
}
/** Reset once at the native SessionStart/SubagentStart boundary, including every resume. */
export function beginStartup(identity: StartupIdentity, payload: Record<string, unknown>): void {
  const saved: Record<string, unknown> = {}
  for (const key of ['source', 'hook_event_name', 'transcript_path', 'agent_transcript_path', 'agent_id', 'agent_type']) {
    if (typeof payload[key] === 'string') saved[key] = payload[key]
  }
  write({ ...identity, workspace: resolve(identity.workspace), version: 1, generation: randomUUID(), status: 'pending', replayPending: payload.source === 'resume', payload: { ...saved, session_id: identity.session, cwd: resolve(identity.workspace) } })
}

/** Loading context never marks it delivered. The caller must actually emit its hook/MCP
 * response first. A failed replay or context request leaves ordinary work blocked. */
export async function prepareStartupDelivery(
  identity: StartupIdentity,
  loadContext: () => Promise<string[]>,
  replay?: (payload: Record<string, unknown>) => Promise<boolean>,
  signal?: AbortSignal,
  daemon?: string,
): Promise<StartupDelivery> {
  signal?.throwIfAborted()
  // Replay is inert but not idempotent: only one startup recovery may prepare it at a time.
  const lock = acquireFileLock(`${pathFor(identity)}.lock`, { timeoutMs: 350 })
  if (!lock) throw new Error('Codex startup recovery is already in progress; retry shortly.')
  try {
    let record = read(identity)
    if (!record) throw new Error('Codex startup checkpoint is missing; resume through the Arsumbris launcher so SessionStart can restore it.')
    if (daemon !== undefined && record.daemon !== daemon) {
      // A new daemon recomputes its startup hooks. Previously delivered context cannot
      // attest that this new initialization completed or that its new instructions were read.
      record = { ...record, daemon, status: 'pending', generation: randomUUID(),
        replayPending: record.replayPending || record.daemon !== undefined }
      write(record)
    }
    if (record.status === 'context-emitted') return { identity, generation: record.generation, context: '', required: false }
    if (record.replayPending) {
      if (!replay || !await replay(record.payload)) throw new Error('Arsumbris resumed history is not ready; restore the daemon and retry before performing work.')
      signal?.throwIfAborted()
      const latest = read(identity)
      if (latest?.generation !== record.generation) throw new Error('Codex run changed while startup was being recovered.')
      record = { ...latest, replayPending: false }
      write(record)
    }
    signal?.throwIfAborted()
    const context = (await loadContext()).join('\n\n')
    signal?.throwIfAborted()
    return { identity, generation: record.generation, context, required: true }
  } finally { lock.release() }
}
export function markStartupContextEmitted(delivery: StartupDelivery): void {
  if (!delivery.required) return
  const record = read(delivery.identity)
  if (!record || record.generation !== delivery.generation) throw new Error('Codex run changed before startup context could be emitted.')
  if (record.replayPending) throw new Error('Resumed history remains pending.')
  write({ ...record, status: 'context-emitted' })
}
/** Missing selected content blocks startup; an explicit empty path list supplies no context. */
export function generatedStartupContext(): string {
  return generatedPaths(INJECT_ENV).map(file => {
    try { return readFileSync(file, 'utf8') }
    catch { throw new Error('Selected generated startup instructions cannot be read; relaunch to regenerate them before performing work') }
  }).join('\n\n')
}
