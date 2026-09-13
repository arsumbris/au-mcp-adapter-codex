#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process'
import { startServer } from '../src/server.ts'
const args = process.argv.slice(2)
const startup = new AbortController()
let tui: ChildProcess | undefined
let termination: ReturnType<typeof setTimeout> | undefined
const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
  const handler = () => {
    if (!tui) { startup.abort(new Error(`Launch interrupted by ${signal}`)); return }
    tui.kill(signal)
    if (signal !== 'SIGINT') termination ??= setTimeout(() => tui?.kill('SIGKILL'), 5000)
  }
  process.on(signal, handler)
  return [signal, handler] as const
})
try {
  if (args[0] !== '--binary' || !args[1] || args[2] !== '--') throw new Error('usage: run --binary <absolute-codex-path> -- [Codex arguments]')
  const server = await startServer(process.env, args[1], [], startup.signal)
  try {
    tui = spawn(args[1], ['--remote', server.endpoint, ...args.slice(3)], { env: server.env, stdio: 'inherit' })
    process.exitCode = await new Promise<number>((resolve, reject) => {
      tui!.once('error', reject)
      tui!.once('exit', code => resolve(code ?? 1))
    })
  } finally { await server.close() }
} catch (error) {
  process.stderr.write(`Codex launch failed: ${String(error)}\n`)
  process.exitCode = 1
} finally {
  clearTimeout(termination)
  for (const [signal, handler] of handlers) process.off(signal, handler)
}
