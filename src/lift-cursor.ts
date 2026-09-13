// Disposable read positions. Only acknowledged transcript prefixes may advance a cursor.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { adapterDeviceDir } from './launch-env.ts'
import type { PendingTools } from './failed-tools.ts'

interface Cursor { identity: string; offset: number; pending: PendingTools }
const cursorDir = (): string => join(adapterDeviceDir(), 'lift')

/** Keep an unterminated final line readable, but checkpoint only through the last newline. */
export function readLiftTail(path: string, workspace: string, session: string, maxBytes = Infinity) {
  const file = join(cursorDir(), createHash('sha256').update(JSON.stringify([realpathSync(workspace), session, realpathSync(path)])).digest('hex') + '.json')
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
    let cursor: Cursor = { identity, offset: 0, pending: {} }
    try {
      const saved: Cursor = JSON.parse(readFileSync(file, 'utf8'))
      if (saved.identity === identity && Number.isSafeInteger(saved.offset) && saved.offset >= 0 && saved.offset <= stat.size &&
          saved.pending && typeof saved.pending === 'object' && !Array.isArray(saved.pending)) cursor = saved
    } catch { /* missing or invalid cursors cause a full reread */ }
    const buffer = Buffer.allocUnsafe(Math.min(stat.size - cursor.offset, maxBytes))
    const bytes = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, cursor.offset))
    const boundary = bytes.lastIndexOf(0x0a) + 1
    return {
      complete: bytes.subarray(0, boundary).toString('utf8'),
      trailing: bytes.subarray(boundary).toString('utf8'),
      pending: cursor.pending,
      save(pending: PendingTools): void {
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          mkdirSync(cursorDir(), { recursive: true, mode: 0o700 })
          writeFileSync(temporary, JSON.stringify({ identity, offset: cursor.offset + boundary, pending }), { mode: 0o600 })
          renameSync(temporary, file)
        } catch { /* a failed cache write only causes a reread */ }
        finally { try { unlinkSync(temporary) } catch {} }
      },
    }
  } finally { closeSync(fd) }
}

/** Cursors are disposable, including while a transcript is active. Lifecycle locks are separate. */
export function sweepCursors(deadline = Infinity, now = Date.now()): void {
  try {
    for (const name of readdirSync(cursorDir())) {
      if (Date.now() >= deadline) break
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const file = join(cursorDir(), name)
      try { if (now - statSync(file).mtimeMs > 7 * 24 * 60 * 60 * 1000) unlinkSync(file) } catch {}
    }
  } catch { /* no cursors yet */ }
}
