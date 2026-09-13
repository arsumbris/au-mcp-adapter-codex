import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { hooksToml, prepareLaunch, type GenerationRunner, type LaunchProfile } from '../src/launch.ts'
import { parseLaunchArguments } from '../src/launch-args.ts'
import { codexResumeRef, parseResumeRef } from '../src/resume-ref.ts'
import { adapterStateDir, generatedPaths, SKILLS_ENV, INJECT_ENV } from '../src/launch-env.ts'
let root: string
let home: string
let workspace: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'au-launch-')); home = join(root, 'home'); workspace = join(root, 'workspace')
  mkdirSync(home); mkdirSync(workspace)
  writeFileSync(join(home, 'config.toml'), '# personal config\n')
  writeFileSync(join(home, 'auth.json'), 'synthetic credential fixture')
  mkdirSync(join(home, 'sessions')); writeFileSync(join(home, 'sessions', 'conversation'), 'native history')
  vi.stubEnv('CODEX_HOME', home)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
const input = (): LaunchProfile => ({ entry: workspace, binary: process.execPath, skills: [], inject: [] })
const generate: GenerationRunner = (script, _profile, select) => {
  const dir = join(root, 'gen', script)
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  if (select?.length === 0) return []
  if (script === 'gen-skills.ts') {
    for (const name of select ?? ['default']) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'SKILL.md'), `skill:${name}`) }
  } else writeFileSync(join(dir, 'content.md'), `inject:${select?.join(',') ?? 'default'}`)
  return [dir]
}

describe('one native launch path', () => {
  it('preserves personal configuration, credentials, history, and uses generated paths directly', async () => {
    const launch = await prepareLaunch({ ...input(), skills: ['alpha'], inject: ['context'] }, generate)
    expect(launch.env.CODEX_HOME).toBe(home)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('# personal config\n')
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('synthetic credential fixture')
    expect(readFileSync(join(home, 'sessions', 'conversation'), 'utf8')).toBe('native history')
    expect(readdirSync(home).sort()).toEqual(['auth.json', 'config.toml', 'sessions'])
    expect(generatedPaths(SKILLS_ENV, launch.env)).toEqual([join(root, 'gen', 'gen-skills.ts')])
    expect(generatedPaths(INJECT_ENV, launch.env)).toEqual([join(root, 'gen', 'gen-inject.ts', 'content.md')])
    expect(adapterStateDir(launch.env)).toContain('/.arsumbris/au-mcp/adapters/codex/')
    expect(existsSync(join(workspace, 'operations'))).toBe(false)
    expect(launch.argv).toContain('--binary'); expect(launch.argv).not.toContain('--runtime')
    expect(launch.env.AU_CODEX_RUNTIME).toBeUndefined()
  })
  it('regenerates on resume after all generated files have been deleted', async () => {
    const first = await prepareLaunch({ ...input(), skills: ['alpha'], inject: ['context'], profile: 'author' }, generate, async () => {})
    const resume = codexResumeRef('thread-123', first.env)!
    const recipe = parseResumeRef(resume)
    expect(recipe.selections).toEqual({ skills: ['alpha'], inject: ['context'], profile: 'author' })
    expect(resume).not.toContain(join(root, 'gen'))
    rmSync(join(root, 'gen'), { recursive: true })
    const regenerate = vi.fn(generate)
    const check = vi.fn(async () => {})
    const next = await prepareLaunch({ entry: workspace, binary: process.execPath, resume }, regenerate, check)
    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenCalledWith(workspace, 'author')
    expect(next.session).not.toBe(first.session)
    expect(next.env.CODEX_HOME).toBe(home)
    expect(next.harnessArgv).toEqual(['resume', 'thread-123', '--cd', workspace])
    expect(readFileSync(generatedPaths(INJECT_ENV, next.env)[0], 'utf8')).toBe('inject:context')
    await expect(prepareLaunch({ ...input(), resume, skills: ['other'] }, generate)).rejects.toThrow('recorded skills')
    await expect(prepareLaunch({ entry: '/other', binary: process.execPath, resume }, generate)).rejects.toThrow('workspace or Codex home')
  })
  it('preserves absent versus empty selections and clears inherited launch settings', async () => {
    const fresh = await prepareLaunch(input(), generate)
    expect(generatedPaths(SKILLS_ENV, fresh.env)).toEqual([])
    expect(fresh.env.AU_MCP_PROFILE).toBeUndefined()
    expect(fresh.unsetEnv).toEqual(expect.arrayContaining(['AU_MCP_PROFILE', 'AU_CODEX_SELECTION', 'AU_CODEX_RUNTIME']))
    const defaults = await prepareLaunch({ entry: workspace, binary: process.execPath }, generate)
    expect(generatedPaths(SKILLS_ENV, defaults.env)).toHaveLength(1)
  })
  it('checks profile and generation failures before handing a launch to Codex', async () => {
    const gen = vi.fn(generate)
    await expect(prepareLaunch({ ...input(), profile: 'missing' }, gen, async () => { throw new Error('Unknown profile') })).rejects.toThrow('Unknown profile')
    expect(gen).not.toHaveBeenCalled()
    await expect(prepareLaunch(input(), () => { throw new Error('Generation failed') })).rejects.toThrow('Generation failed')
    await expect(prepareLaunch(input(), () => ['/missing/content'])).rejects.toThrow('Generated content is missing')
  })
  it('canonicalizes existing profile paths and leaves authored names literal', async () => {
    const file = join(workspace, 'profile.yaml'); writeFileSync(file, 'fixture')
    const alias = join(workspace, 'alias.yaml'); symlinkSync(file, alias)
    const check = vi.fn(async () => {})
    await prepareLaunch({ ...input(), profile: alias }, generate, check)
    expect(check).toHaveBeenCalledWith(workspace, realpathSync(file))
    await prepareLaunch({ ...input(), profile: 'Authored name' }, generate, check)
    expect(check).toHaveBeenLastCalledWith(workspace, 'Authored name')
  })
  it('rejects unsupported settings and replacement Codex homes', async () => {
    await expect(prepareLaunch({ ...input(), injectBudget: 0 }, generate)).rejects.toThrow('at least 256')
    await expect(prepareLaunch({ ...input(), binary: 'codex' }, generate)).rejects.toThrow('absolute')
    writeFileSync(join(home, 'arsumbris-runtime.json'), '{}')
    await expect(prepareLaunch(input(), generate)).rejects.toThrow('normal Codex home')
  })
})

it('parses selections strictly and exposes only thread/recipe resume', () => {
  expect(parseLaunchArguments(['--workspace', '/ws', '--binary', '/codex', '--skills', '--inject', 'a:b,c:d'])).toMatchObject({ skills: [], inject: ['a:b', 'c:d'] })
  for (const flags of [['--resume-home', '/old'], ['--skills-typo'], ['--profile'], ['--native-tools', 'Bash']]) {
    expect(() => parseLaunchArguments(['--workspace', '/ws', '--binary', '/codex', ...flags])).toThrow()
  }
})
it.each(['gen-skills.ts', 'gen-inject.ts'])('%s rejects removed and misspelled options before generation', script => {
  for (const flag of ['--generation-home', '--selection-typo']) {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', script), '--workspace', workspace, flag, root], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`Unknown option: ${flag}`)
  }
})
it('registers the full hook lifecycle without granting hook trust', () => {
  const hooks = hooksToml('/node path')
  for (const event of ['SessionStart', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PreToolUse', 'PostToolUse']) expect(hooks).toContain(`${event} =`)
  expect(hooks).toContain('timeout = 150'); expect(hooks).toContain('additionalContextLimit = 0')
  expect(hooks).not.toContain('bypass'); expect(hooks).not.toContain('inject-emit.ts')
})
