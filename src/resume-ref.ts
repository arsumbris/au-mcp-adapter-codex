import { isAbsolute, resolve } from 'node:path'
import { launchSelection, nativeCodexHome, validateSelection, type LaunchSelection } from './launch-env.ts'

export interface ResumeRecipe { version: 2; thread: string; home: string; workspace: string; selections: LaunchSelection }
export const validThread = (thread: string): boolean => /^[a-zA-Z0-9_-]{1,200}$/.test(thread)

export function parseResumeRef(value: string): ResumeRecipe {
  let recipe: ResumeRecipe
  try { recipe = JSON.parse(value) } catch { throw new Error('Invalid Codex resume recipe') }
  if (!recipe || recipe.version !== 2 || typeof recipe.home !== 'string' || !isAbsolute(recipe.home) ||
      typeof recipe.workspace !== 'string' || !isAbsolute(recipe.workspace) || typeof recipe.thread !== 'string' || !validThread(recipe.thread)) {
    throw new Error('Invalid Codex resume recipe')
  }
  validateSelection(recipe.selections)
  return recipe
}

/** Durable relaunch inputs contain no generated paths or process identities. */
export function codexResumeRef(thread: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.AU_MCP_WORKSPACE || !validThread(thread)) return undefined
  return JSON.stringify({ version: 2, thread, home: nativeCodexHome(env),
    workspace: resolve(env.AU_MCP_WORKSPACE), selections: launchSelection(env) } satisfies ResumeRecipe)
}
