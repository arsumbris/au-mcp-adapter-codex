import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapterStateDir, generatedPaths, launchSelection, nativeCodexHome, resolveLaunchEnv, INJECT_ENV, SKILLS_ENV, SELECTION_ENV } from '../src/launch-env.ts'
it('rejects a retired home even after its ownership marker has been deleted', () => {
  const retired = join(homedir(), '.arsumbris', 'au-mcp-adapter-codex')
  for (const path of [retired, join(retired, 'runtimes', 'deleted-home'), join(retired, 'native', 'deleted-selection')]) {
    expect(() => resolveLaunchEnv({ CODEX_HOME: path })).toThrow('normal Codex home')
  }
  expect(nativeCodexHome({})).toBe(join(homedir(), '.codex'))
  expect(nativeCodexHome({ CODEX_HOME: '/custom/codex' })).toBe('/custom/codex')
})
it('stores coordination outside the workspace and shares locks across workspace aliases', () => {
  expect(adapterStateDir({ CODEX_HOME: '/native' })).toBeUndefined()
  const root = mkdtempSync(join(tmpdir(), 'au-state-location-'))
  try {
    const workspace = join(root, 'workspace'), alias = join(root, 'alias'), other = join(root, 'other')
    mkdirSync(workspace); mkdirSync(other); symlinkSync(workspace, alias)
    const state = adapterStateDir({ AU_MCP_WORKSPACE: workspace })
    expect(state).toMatch(/\/\.arsumbris\/au-mcp\/adapters\/codex\/[a-f0-9]{64}$/)
    expect(state).toBe(adapterStateDir({ CODEX_HOME: '/native', AU_MCP_WORKSPACE: alias }))
    expect(state).not.toBe(adapterStateDir({ AU_MCP_WORKSPACE: other }))
    expect(state).not.toContain(workspace)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it('accepts explicit generated paths and distinguishes empty selections from defaults', () => {
  const env = { [SKILLS_ENV]: '["/generated/skills"]', [INJECT_ENV]: '[]', [SELECTION_ENV]: '{"skills":[]}', AU_MCP_PROFILE: 'author' }
  expect(resolveLaunchEnv(env)).toBe(env)
  expect(generatedPaths(SKILLS_ENV, env)).toEqual(['/generated/skills'])
  expect(launchSelection(env)).toEqual({ skills: [], profile: 'author' })
  expect(launchSelection({})).toEqual({ profile: undefined })
})
it.each([
  { [SKILLS_ENV]: '["relative"]' }, { [INJECT_ENV]: '{}' }, { [SELECTION_ENV]: '{"tools":[]}' },
  { [SELECTION_ENV]: '{"injectBudget":0}' }, { AU_MCP_NATIVE_TOOLS: '' },
])('refuses malformed launch settings %#', env => { expect(() => resolveLaunchEnv(env)).toThrow() })
