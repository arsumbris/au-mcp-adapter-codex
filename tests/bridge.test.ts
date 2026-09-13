import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { resolveEntry, resolveContext, buildNativeRestrictionNote } from '../src/bridge.ts'


const created: string[] = []
let savedWs: string | undefined

beforeEach(() => {
  // Isolate AU_MCP_WORKSPACE per test (the walk only runs when it is unset).
  savedWs = process.env.AU_MCP_WORKSPACE
  delete process.env.AU_MCP_WORKSPACE
})
afterEach(() => {
  if (savedWs === undefined) delete process.env.AU_MCP_WORKSPACE
  else process.env.AU_MCP_WORKSPACE = savedWs
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A temp folder-repo: <root>/.arsumbris/repo.yaml + a nested <root>/a/b subdir. */
function tempRepo(): { root: string; deep: string } {
  const root = mkdtempSync(join(tmpdir(), 'au-codex-entry-'))
  created.push(root)
  mkdirSync(join(root, '.arsumbris'), { recursive: true })
  writeFileSync(join(root, '.arsumbris', 'repo.yaml'), 'name: fixture\n')
  const deep = join(root, 'a', 'b')
  mkdirSync(deep, { recursive: true })
  return { root, deep }
}

describe('resolveEntry', () => {
  it('walks a subdir UP to the nearest .arsumbris/repo.yaml (the entry)', () => {
    const { root, deep } = tempRepo()
    expect(resolveEntry(deep)).toBe(resolve(root))
  })

  it('returns the entry itself when start IS the entry', () => {
    const { root } = tempRepo()
    expect(resolveEntry(root)).toBe(resolve(root))
  })

  it('AU_MCP_WORKSPACE wins over the walk (the launcher sets the exact entry)', () => {
    const { deep } = tempRepo()
    process.env.AU_MCP_WORKSPACE = '/some/explicit/entry'
    expect(resolveEntry(deep)).toBe(resolve('/some/explicit/entry'))
  })

  it('falls back to the start dir when no .arsumbris/repo.yaml is found up the tree', () => {
    const bare = mkdtempSync(join(tmpdir(), 'au-codex-bare-'))
    created.push(bare)
    expect(resolveEntry(bare)).toBe(resolve(bare))
  })
})

describe('resolveContext', () => {
  it('pulls session_id and walks payload.cwd to the entry', () => {
    const { root, deep } = tempRepo()
    const ctx = resolveContext({ cwd: deep, session_id: 'sess-123' })
    expect(ctx.session).toBe('sess-123')
    expect(ctx.workspace).toBe(resolve(root))
  })

  it('uses the native child agent_id when Codex retains the parent session_id', () => {
    expect(resolveContext({ cwd: '/vault', session_id: 'parent-thread', agent_id: 'child-thread' }).session).toBe('child-thread')
  })

  it('defaults session to unknown-session and yields an absolute workspace when payload is null', () => {
    const ctx = resolveContext(null)
    expect(ctx.session).toBe('unknown-session')
    expect(ctx.workspace.startsWith('/')).toBe(true)
  })
})

describe('buildNativeRestrictionNote', () => {
  it('returns null when the session is unrestricted', () => {
    expect(buildNativeRestrictionNote({ denyNative: false })).toBeNull()
  })

  it('injects the "use the gate" note when the session is restricted', () => {
    const ctx = buildNativeRestrictionNote({ denyNative: true })
    expect(ctx).toMatch(/restricts native tools/)
    expect(ctx).toMatch(/native-tool policy blocks/)
    expect(ctx).toMatch(/gate/)
  })

  it('names no tool, since the session tool set varies per launch', () => {
    // An inventory here would promise tools a scoped session may not have; the gate's own
    // instructions carry the generated catalogue. This note states the posture only.
    const ctx = buildNativeRestrictionNote({ denyNative: true }) ?? ''
    for (const tool of ['read_file', 'write_file', 'edit_file', 'grep_files', 'au_']) {
      expect(ctx).not.toContain(tool)
    }
  })
})
