// OS advisory locks on permanent inodes. Never unlink or reclaim locks by PID/age.
// macOS lockf's fd mode acquires flock on the open file description shared with Node.
import { closeSync, constants, mkdirSync, openSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

export interface FileLock {
  /** May be passed as an inherited child descriptor to retain ownership if the parent dies. */
  fd: number
  release(): void
}

export function acquireFileLock(path: string, options: { timeoutMs?: number } = {}): FileLock | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let released = false
  const release = (): void => { if (!released) { released = true; closeSync(fd) } }
  try {
    const darwin = process.platform === 'darwin'
    if (!darwin && process.platform !== 'linux') throw new Error(`Advisory file locking is unsupported on ${process.platform}`)
    const binary = darwin ? '/usr/bin/lockf' : '/usr/bin/flock'
    const args = darwin ? ['-s', '-t', '0', '3'] : ['--exclusive', '--nonblock', '3']
    const result = spawnSync(binary, args, { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: options.timeoutMs ?? 5_000 })
    if (result.status === (darwin ? 75 : 1)) { release(); return undefined }
    if (result.error || result.status !== 0) throw new Error(`Cannot acquire OS advisory lock using ${binary}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`)
    return { fd, release }
  } catch (error) { release(); throw error }
}
