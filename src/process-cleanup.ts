import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { adapterStateDir } from './launch-env.ts'

/** Call only while holding the drained process lease. No daemon or thread restart. */
export async function cleanupProcessThreads(env: NodeJS.ProcessEnv): Promise<string> {
  const state = adapterStateDir(env)
  if (!state || !existsSync(join(state, 'threads'))) return ''
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '../bin/process-cleanup.ts')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    const timer = setTimeout(() => { diagnostic += '\nProcess cleanup timed out; remaining registrations were retained.'; child.kill('SIGKILL') }, 3000)
    child.stderr.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-16000) })
    child.once('error', error => { diagnostic += `\nProcess cleanup failed: ${error.message}` })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0 && !diagnostic) diagnostic = `Process cleanup exited ${code}; registrations may remain active.\n`
      resolve(diagnostic)
    })
  })
}
