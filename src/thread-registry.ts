import { adapterStateDir, RUN_ID_ENV } from './launch-env.ts'
// Local launch membership, independent of the daemon's single-handle binding table.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { acquireFileLock } from './file-lock.ts'

export { RUN_ID_ENV } from './launch-env.ts'
export async function withThreadLock<T>(session: string, work: () => Promise<T>, deadline = Date.now() + 8000): Promise<T> {
  for (;;) {
    if (Date.now() >= deadline) throw new Error('Thread lifecycle is busy; retry after its startup or shutdown completes.')
    const lock = acquireFileLock(`${recordPath(session)}.lock`, { timeoutMs: Math.max(1, Math.min(350, deadline - Date.now())) })
    if (lock) { try { return await work() } finally { lock.release() } }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

function recordPath(session: string, stateDir = adapterStateDir()): string {
  if (!stateDir || !/^[a-zA-Z0-9_-]{1,200}$/.test(session) || session === 'unknown-session') throw new Error('Missing AU workspace or invalid thread identity.')
  return join(stateDir, 'threads', `${createHash('sha256').update(session).digest('hex')}.json`)
}
export async function registerLaunchSession(session: string, workspace: string, handle: string): Promise<void> {
  await withThreadLock(session, async () => {
    if (!handle.trim()) throw new Error('Missing AU_MCP_SESSION launch identity.')
    const file = recordPath(session)
    mkdirSync(join(adapterStateDir()!, 'threads'), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ session, workspace: resolve(workspace), handle, active: true, generation: randomUUID(), owner: process.env[RUN_ID_ENV] }), { mode: 0o600 })
    renameSync(temporary, file)
  })
}
export function assertLaunchSession(session: string, workspace: string, handle: string, stateDir = adapterStateDir()): void {
  let record: { session?: unknown; workspace?: unknown; handle?: unknown; active?: unknown }
  try { record = JSON.parse(readFileSync(recordPath(session, stateDir), 'utf8')) } catch { throw new Error('Codex thread is not registered for this launch. Its SessionStart/SubagentStart hook must complete first.') }
  if (record.active === false) throw new Error('Codex thread has closed; its SessionStart hook must register the resumed thread first.')
  if (record.session !== session || record.workspace !== resolve(workspace) || record.handle !== handle) throw new Error('Codex thread belongs to a different Arsumbris launch or workspace.')
}

/** Enumerate only validated active records in this workspace and this exact launch/workspace.
 * Stale/foreign/malformed records cannot cause another launch's thread to be closed. */
export function listLaunchSessions(workspace: string, handle: string): string[] {
  const stateDir = adapterStateDir()
  if (!stateDir || !handle.trim()) return []
  const directory = join(stateDir, 'threads')
  let names: string[]
  try { names = readdirSync(directory) } catch { return [] }
  const sessions = new Set<string>()
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { session?: unknown; workspace?: unknown; handle?: unknown; active?: unknown }
      if (typeof record.session !== 'string' || record.workspace !== resolve(workspace) || record.handle !== handle || record.active === false) continue
      if (recordPath(record.session) !== join(directory, name)) continue
      sessions.add(record.session)
    } catch { /* malformed/stale entry is not authority to close a thread */ }
  }
  return [...sessions]
}
/** Mark only acknowledged closes inactive; a lost close reply stays visible for recovery. */
export function markLaunchSessionClosed(session: string, workspace: string, handle: string): void {
  const file = recordPath(session)
  const record = JSON.parse(readFileSync(file, 'utf8')) as { session?: unknown; workspace?: unknown; handle?: unknown; active?: unknown }
  if (record.session !== session || record.workspace !== resolve(workspace) || record.handle !== handle) throw new Error('Cannot close a foreign launch thread registry entry.')
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...record, active: false }), { mode: 0o600 })
  renameSync(temporary, file)
}

/** Capture before asynchronous shutdown work; a later registration is a different incarnation. */
export function registrationGeneration(session: string, workspace: string, handle: string): string | undefined {
  assertLaunchSession(session, workspace, handle)
  const record = JSON.parse(readFileSync(recordPath(session), 'utf8')) as { generation?: string; owner?: string }
  if (record.owner !== process.env[RUN_ID_ENV]) throw new Error('Shutdown belongs to a different Codex process incarnation; no thread was closed.')
  return record.generation
}

/** Called only after the harness and inherited process lease holders have exited. */
export async function closeOwnedProcessThreads(close: (thread: string) => Promise<void>, workspace: string, handle: string): Promise<void> {
  if (!process.env[RUN_ID_ENV]) return
  const deadline = Date.now() + 2200
  const results = await Promise.allSettled(listLaunchSessions(workspace, handle).map(async session => {
    let generation: string | undefined
    try { generation = registrationGeneration(session, workspace, handle) } catch { return }
    await withThreadLock(session, async () => {
      if (registrationGeneration(session, workspace, handle) !== generation) return
      await close(session)
      markLaunchSessionClosed(session, workspace, handle)
    }, deadline)
  }))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new Error(`${failures.length} thread cleanup operation(s) were not acknowledged; registrations remain available for recovery.`)
}
