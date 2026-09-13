// Compose shared generation with Codex invocation settings. Native storage stays with Codex.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { buildLaunchEnv, LAUNCH_ENV, connectSocket, createDaemonClient, socketPath } from '@arsumbris/au-mcp-sdk'
import { LAUNCH_ENV_KEYS, SKILLS_ENV, INJECT_ENV, SELECTION_ENV, assertGeneratedContent, nativeCodexHome, validateSelection, type LaunchSelection } from './launch-env.ts'
import { parseResumeRef, validThread, type ResumeRecipe } from './resume-ref.ts'
import { verifyProfile } from './profile-preflight.ts'
import { CONTENT_FILE } from './inject-codex.ts'

export interface LaunchProfile extends LaunchSelection {
  entry: string
  binary: string
  resume?: string
  node?: string
}
export interface PreparedLaunch {
  session: string
  binary: string
  argv: string[]
  harnessBinary: string
  harnessArgv: string[]
  env: Record<string, string>
  command: string
  unsetEnv: string[]
}

const HOOK_SCRIPTS: Record<string, string> = {
  SessionStart: 'session-start.ts',
  SubagentStart: 'subagent-start.ts',
  UserPromptSubmit: 'user-prompt-submit.ts',
  PreToolUse: 'pre-tool-use.ts',
  PostToolUse: 'post-tool-use.ts',
  PreCompact: 'pre-compact.ts',
  Stop: 'stop.ts',
  SubagentStop: 'subagent-stop.ts',
  SessionEnd: 'session-end.ts',
}

const tomlStr = (s: string): string => JSON.stringify(s)
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const pkgPath = (...parts: string[]): string => resolve(import.meta.dirname, '..', ...parts)
export const mcpServerPath = (): string => pkgPath('bin', 'mcp-server.ts')

/** Commands stay identical across launches: context comes from the inherited environment. */
export function hooksToml(node = process.execPath): string {
  const command = (script: string): string => `${shellQuote(node)} --experimental-strip-types ${shellQuote(pkgPath('hooks', script))}`
  const lines = ['[hooks]']
  for (const [event, script] of Object.entries(HOOK_SCRIPTS)) {
    const timeout = event === 'PreToolUse' ? 150 : event === 'SessionEnd' ? 3 : 60
    const contextLimit = ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event) ? ', additionalContextLimit = 0' : ''
    const handler = (name: string): string => `{ type = "command", command = ${tomlStr(command(name))}, timeout = ${timeout}${contextLimit} }`
    const handlers = [handler(script)]
    // Lifecycle readiness owns static and computed context together, including recovery.
    lines.push(`${event} = [{ hooks = [${handlers.join(', ')}] }]`)
  }
  return `${lines.join('\n')}\n`
}

export type GenerationRunner = (script: string, profile: LaunchProfile, select: string[] | undefined, flag: string) => string[]

/** The shared materializers own paths, replacement, and garbage collection. */
export const runGeneration: GenerationRunner = (script, profile, select, flag) => {
  const args = ['--experimental-strip-types', pkgPath('bin', script), '--workspace', profile.entry]
  if (select !== undefined) args.push(flag, ...select)
  if (script === 'gen-inject.ts' && profile.injectBudget !== undefined) args.push('--inject-budget', String(profile.injectBudget))
  const result = spawnSync(profile.node ?? process.execPath, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, [LAUNCH_ENV.WORKSPACE]: profile.entry },
  })
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0) throw new Error(`${script} failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`)
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

async function resumeRecipe(value: string, workspace: string): Promise<ResumeRecipe> {
  if (value.trim().startsWith('{')) return parseResumeRef(value)
  if (!validThread(value)) throw new Error('Invalid Codex thread ID')
  const transport = await connectSocket(socketPath(workspace))
  const client = createDaemonClient(transport, { requestTimeoutMs: 8000 })
  try {
    const record = (await client.listDormant()).find(item => item.id === value && item.harness === 'mcp.adapter.codex')
    if (!record?.resumeRef) throw new Error('No AU launch selection is recorded for this dormant Codex thread')
    return parseResumeRef(record.resumeRef)
  } finally { client.dispose(); transport.close() }
}

export async function prepareLaunch(input: LaunchProfile, generate: GenerationRunner = runGeneration,
  verify: (workspace: string, profile: string) => Promise<void> = verifyProfile): Promise<PreparedLaunch> {
  for (const key of ['tools', 'nativeTools', 'resumeHome', 'resumeRuntime', 'runtimeRoot', 'authHome']) {
    if (key in input) throw new Error(`Unsupported launch option ${key}; use the workspace, profile, and native thread ID`)
  }
  const profile = { ...input, entry: resolve(input.entry), node: input.node ?? process.execPath }
  if (!isAbsolute(profile.binary) || !isAbsolute(profile.node)) throw new Error('--binary and Node executable must be absolute paths')
  if (profile.profile && (isAbsolute(profile.profile) || profile.profile.startsWith('./') || profile.profile.startsWith('../'))) {
    const path = resolve(profile.entry, profile.profile)
    if (existsSync(path) && statSync(path).isFile()) profile.profile = realpathSync(path)
  }
  const home = nativeCodexHome()
  if (profile.resume) {
    const recipe = await resumeRecipe(profile.resume, profile.entry)
    if (recipe.workspace !== profile.entry || recipe.home !== home) throw new Error('Resume workspace or Codex home does not match the recorded launch')
    for (const key of ['skills', 'inject', 'injectBudget', 'profile'] as const) {
      if (profile[key] !== undefined && JSON.stringify(profile[key]) !== JSON.stringify(recipe.selections[key])) throw new Error(`Resume restores the recorded ${key}; start a new conversation to change it`)
    }
    Object.assign(profile, recipe.selections, { resume: recipe.thread })
  }
  const selections = validateSelection({ skills: profile.skills, inject: profile.inject, injectBudget: profile.injectBudget, profile: profile.profile })
  if (profile.profile !== undefined) await verify(profile.entry, profile.profile)
  const skills = generate('gen-skills.ts', profile, profile.skills, '--skills')
  const injects = generate('gen-inject.ts', profile, profile.inject, '--inject').map(root => join(root, CONTENT_FILE))
  const { session, env: sharedEnv } = buildLaunchEnv({ workspace: profile.entry, profile: profile.profile })
  const { profile: _profile, ...contentSelection } = selections
  const env = { ...sharedEnv, CODEX_HOME: home, [SKILLS_ENV]: JSON.stringify(skills), [INJECT_ENV]: JSON.stringify(injects), [SELECTION_ENV]: JSON.stringify(contentSelection) }
  assertGeneratedContent(env)
  const harnessArgv = [...(profile.resume ? ['resume', profile.resume] : []), '--cd', profile.entry]
  const argv = ['--experimental-strip-types', pkgPath('bin', 'run.ts'), '--binary', profile.binary, '--', ...harnessArgv]
  const unsetEnv = LAUNCH_ENV_KEYS
  const command = ['env', ...unsetEnv.flatMap(key => ['-u', key]), ...Object.entries(env).map(([key, value]) => `${key}=${value}`), profile.node, ...argv].map(shellQuote).join(' ')
  return { session, binary: profile.node, argv, harnessBinary: profile.binary, harnessArgv, env, command, unsetEnv }
}
