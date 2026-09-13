// Headless hook-contract fixture. Production launch coverage uses the real TUI runner.
import { cpSync, mkdirSync, realpathSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { PreparedLaunch } from '../src/launch.ts'
import { generatedPaths, SKILLS_ENV, RUN_ID_ENV } from '../src/launch-env.ts'
import { invocationConfig } from '../src/server.ts'

export function spawnFixture(launch: PreparedLaunch, argv: string[]) {
  const home = launch.env.CODEX_HOME
  mkdirSync(home, { recursive: true })
  const rel = relative(realpathSync(tmpdir()), realpathSync(home))
  if (rel.startsWith('..') || !rel.startsWith('au-')) throw new Error('Codex fixture home must be inside its disposable test directory')
  // exec has no process-level extra-root setter. These tests exercise hooks, not skill loading.
  for (const root of generatedPaths(SKILLS_ENV, launch.env)) {
    if (existsSync(root)) cpSync(root, join(home, 'skills'), { recursive: true })
  }
  const env = { ...process.env }
  for (const key of launch.unsetEnv) delete env[key]
  for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/.test(key)) delete env[key]
  Object.assign(env, launch.env, { [RUN_ID_ENV]: launch.session })
  const at = argv.includes('resume') ? argv.indexOf('resume') + 1 : 1
  return spawn(launch.harnessBinary, [...argv.slice(0, at), ...invocationConfig(), ...argv.slice(at)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}
