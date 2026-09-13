import { expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareLaunch } from '../src/launch.ts'
import { adapterStateDir } from '../src/launch-env.ts'
import { acquireFileLock } from '../src/file-lock.ts'

it.each([false, true])('cancelling startup finishes while preserving a live descendant lease: %s', async retainDescendant => {
  const root = mkdtempSync(join(tmpdir(), 'au-runner-'))
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  const binary = join(root, 'codex.cjs'), probe = join(root, 'backend.json')
  mkdirSync(home); mkdirSync(workspace)
  writeFileSync(binary, `#!${process.execPath}
setInterval(() => {}, 1000)
const descendant = ${retainDescendant} ? require('node:child_process').spawn(process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'inherit', 3] }) : undefined
require('node:fs').writeFileSync(process.env.AU_FIXTURE_PROBE, JSON.stringify({
  pid: process.pid, endpoint: process.argv[process.argv.indexOf('--listen') + 1], descendant: descendant?.pid
}))
`, { mode: 0o700 })
  vi.stubEnv('CODEX_HOME', home)
  const launch = await prepareLaunch({ entry: workspace, binary, skills: [], inject: [] }, () => [])
  const env = { ...process.env }
  for (const key of launch.unsetEnv) delete env[key]
  Object.assign(env, launch.env, { AU_FIXTURE_PROBE: probe })
  const runner = spawn(launch.binary, launch.argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostic = ''
  runner.stderr.on('data', chunk => { diagnostic += String(chunk) })
  const exited = new Promise<number | null>((resolve, reject) => { runner.once('error', reject); runner.once('close', resolve) })
  let backend: { pid: number; endpoint: string; descendant?: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await vi.waitFor(() => { backend = JSON.parse(readFileSync(probe, 'utf8')) }, { timeout: 5000 })
    runner.kill('SIGTERM')
    const code = await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Runner did not shut down: ${diagnostic}`)), 7000)
    })])
    expect(code, diagnostic).toBe(1)
    expect(() => process.kill(backend!.pid, 0)).toThrow()
    expect(existsSync(dirname(backend!.endpoint.replace(/^unix:\/\//, '')))).toBe(false)
    const lease = join(adapterStateDir(launch.env)!, 'leases', `${createHash('sha256').update(launch.session).digest('hex')}.lock`)
    const lock = acquireFileLock(lease)
    if (retainDescendant) {
      expect(() => process.kill(backend!.descendant!, 0)).not.toThrow()
      try { expect(lock).toBeUndefined() } finally { lock?.release() }
      process.kill(backend!.descendant!, 'SIGTERM'); backend!.descendant = undefined
      await vi.waitFor(() => {
        const drained = acquireFileLock(lease)
        try { expect(drained).toBeDefined() } finally { drained?.release() }
      })
    } else {
      expect(lock).toBeDefined(); lock!.release()
    }
  } finally {
    clearTimeout(timer)
    runner.kill('SIGKILL')
    if (backend) { try { process.kill(backend.pid, 'SIGKILL') } catch {} }
    if (backend?.descendant) { try { process.kill(backend.descendant, 'SIGKILL') } catch {} }
    await exited.catch(() => {})
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
