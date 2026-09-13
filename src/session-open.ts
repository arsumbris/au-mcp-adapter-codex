import { assertLaunchSession, withThreadLock } from './thread-registry.ts'
import { adapterStateDir } from './launch-env.ts'
// Stand-in for the kernel's missing initialized-session acknowledgement. Serialize opens
// across adapter processes; a lost opening reply taints that thread until the daemon socket
// is replaced. A later idempotent open otherwise returns before the first initialization ends.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { socketPath, type AdapterInfo, type DaemonClient } from '@arsumbris/au-mcp-sdk'
import { acquireFileLock, type FileLock } from './file-lock.ts'
import { verifyProfile } from './profile-preflight.ts'

interface OpenRecord { daemon: string; status: 'opening' | 'ready' | 'tainted' }
interface OpenOptions {
  handle?: string
  timeoutMs?: number
  signal?: AbortSignal
  stateDir?: string
  daemonIdentity?: () => string
  verifyProfile?: (workspace: string, profile: string) => Promise<void>
}
export function currentDaemonIdentity(workspace: string): string {
  const stat = statSync(socketPath(workspace), { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}`
}
function persist(file: string, record: OpenRecord): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
  renameSync(temporary, file)
}
async function within<T>(operation: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error('Session initialization timed out')
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Session initialization timed out')), Math.max(1, deadline - Date.now()))
      abort = () => reject(signal?.reason ?? new Error('Session initialization aborted'))
      signal?.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
}

export async function openCodexSession(client: DaemonClient, info: AdapterInfo, options: OpenOptions = {}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000)
  if (options.handle !== undefined) {
    const { handle, ...unlocked } = options
    return withThreadLock(info.session, async () => {
      assertLaunchSession(info.session, info.workspace, handle)
      await openCodexSession(client, info, { ...unlocked, timeoutMs: Math.max(1, deadline - Date.now()) })
    }, deadline)
  }
  const stateDir = options.stateDir ?? adapterStateDir()
  if (!stateDir) throw new Error('Codex session initialization requires its workspace state directory')
  const file = join(stateDir, 'startup', `open-${createHash('sha256').update(info.session).digest('hex')}.json`)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  let lock: FileLock | undefined
  while (!lock) {
    options.signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error('Another adapter process is still initializing this Codex thread; retry shortly')
    lock = acquireFileLock(`${file}.lock`, { timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) })
    if (!lock) await within(new Promise(resolve => setTimeout(resolve, 25)), deadline, options.signal)
  }
  try {
    const daemon = (options.daemonIdentity ?? (() => currentDaemonIdentity(info.workspace)))()
    let previous: OpenRecord | undefined
    try { previous = JSON.parse(readFileSync(file, 'utf8')) as OpenRecord }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Session initialization checkpoint is unreadable') }
    if (previous && (typeof previous.daemon !== 'string' || !['opening', 'ready', 'tainted'].includes(previous.status))) throw new Error('Session initialization checkpoint is invalid')
    if (previous?.daemon === daemon && previous.status !== 'ready') {
      throw new Error('A previous session-open did not complete reliably. Restart the Arsumbris daemon or start a new Codex thread before retrying; this thread remains blocked.')
    }
    if (info.profile) await within((options.verifyProfile ?? verifyProfile)(info.workspace, info.profile), deadline, options.signal)
    options.signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error('Session initialization timed out before session-open was sent')
    persist(file, { daemon, status: 'opening' })
    try {
      await within(client.sessionOpen(info), deadline, options.signal)
      persist(file, { daemon, status: 'ready' })
    } catch (error) {
      // The RPC was sent: neither timeout nor lost transport proves that initialization
      // finished. Persist the uncertainty instead of trusting the next fast duplicate open.
      persist(file, { daemon, status: 'tainted' })
      throw error
    }
  } finally { lock.release() }
}
