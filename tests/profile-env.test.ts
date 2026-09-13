import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveProfile } from '../src/bridge.ts'
afterEach(() => vi.unstubAllEnvs())
describe('shared profile launch contract', () => {
  it('forwards an opaque profile locator', () => {
    vi.stubEnv('CODEX_HOME', undefined)
    vi.stubEnv('AU_MCP_PROFILE', ' profile::owner ')
    expect(resolveProfile()).toBe('profile::owner')
  })
})
