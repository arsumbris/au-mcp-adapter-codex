import { isAbsolute, join, resolve, sep } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { LAUNCH_ENV, auDeviceDir, parseProfile } from '@arsumbris/au-mcp-sdk'

export const RUN_ID_ENV = 'AU_CODEX_RUN_ID'
export const SKILLS_ENV = 'AU_CODEX_SKILLS'
export const INJECT_ENV = 'AU_CODEX_INJECT'
export const SELECTION_ENV = 'AU_CODEX_SELECTION'
export const LAUNCH_ENV_KEYS = [...Object.values(LAUNCH_ENV), RUN_ID_ENV, SKILLS_ENV, INJECT_ENV, SELECTION_ENV,
  'AU_MCP_TOOLS', 'AU_MCP_NATIVE_TOOLS', 'AU_CODEX_RUNTIME']

export interface LaunchSelection { skills?: string[]; inject?: string[]; injectBudget?: number; profile?: string }

export function nativeCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolve(env.CODEX_HOME ?? join(homedir(), '.codex'))
  const retired = join(homedir(), '.arsumbris', 'au-mcp-adapter-codex')
  if (home === retired || home.startsWith(retired + sep) || existsSync(join(home, 'arsumbris-runtime.json'))) {
    throw new Error('Launch from your normal Codex home; adapter-created homes are no longer supported')
  }
  return home
}

export function validateSelection(value: unknown): LaunchSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex capability selection')
  const selection = value as Record<string, unknown>
  for (const key of Object.keys(selection)) {
    if (!['skills', 'inject', 'injectBudget', 'profile'].includes(key)) throw new Error(`Unknown selection field: ${key}`)
  }
  for (const key of ['skills', 'inject'] as const) {
    const list = selection[key]
    if (list !== undefined && (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !item.trim()))) throw new Error(`Invalid ${key} selection`)
  }
  if (selection.profile !== undefined && (typeof selection.profile !== 'string' || !selection.profile.trim())) throw new Error('Invalid profile locator')
  if (selection.injectBudget !== undefined && (!Number.isSafeInteger(selection.injectBudget) || Number(selection.injectBudget) < 256)) throw new Error('--inject-budget must be an integer of at least 256 bytes')
  return value as LaunchSelection
}

export function launchSelection(env: NodeJS.ProcessEnv = process.env): LaunchSelection {
  const selected = validateSelection(JSON.parse(env[SELECTION_ENV] ?? '{}'))
  return { ...selected, profile: parseProfile(env[LAUNCH_ENV.PROFILE]) }
}

export function generatedPaths(key: typeof SKILLS_ENV | typeof INJECT_ENV, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: unknown = JSON.parse(env[key] ?? '[]')
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error(`Invalid ${key} paths`)
  return paths
}

export function assertGeneratedContent(env: NodeJS.ProcessEnv): void {
  for (const key of [SKILLS_ENV, INJECT_ENV] as const) {
    for (const path of generatedPaths(key, env)) {
      let valid = false
      try { const stat = statSync(path); valid = key === SKILLS_ENV ? stat.isDirectory() : stat.isFile() } catch {}
      if (!valid) throw new Error(`Generated content is missing or invalid: ${path}; relaunch to regenerate it`)
    }
  }
}

export const adapterDeviceDir = (): string => join(auDeviceDir('au-mcp', 'adapters'), 'codex')

/** Workspace-scoped coordination lives on the device; Codex owns its native home. */
export function adapterStateDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const workspace = env[LAUNCH_ENV.WORKSPACE]
  return workspace ? join(adapterDeviceDir(), createHash('sha256').update(realpathSync(workspace)).digest('hex')) : undefined
}

export function resolveLaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  nativeCodexHome(env)
  for (const key of ['AU_MCP_TOOLS', 'AU_MCP_NATIVE_TOOLS']) {
    if (env[key] !== undefined) throw new Error(`${key} is retired; use an agent profile`)
  }
  launchSelection(env)
  generatedPaths(SKILLS_ENV, env)
  generatedPaths(INJECT_ENV, env)
  return env
}
