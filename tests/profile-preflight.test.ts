import { it, expect, vi } from 'vitest'
import type { EngineBroker } from '@arsumbris/au-mcp'
import { assertProfileRows, verifyProfile } from '../src/profile-preflight.ts'
const row = { path: '/workspace/profile.md', fields: { name: 'author' } }
const broker = (overrides: Partial<EngineBroker> = {}): EngineBroker => ({ socketPath: '/tmp/fixture.sock', available: () => true, read: async () => ({ result: [row] }), mutate: async () => { throw new Error('must not mutate') }, ...overrides })
it('uses the same name-or-path locator matching as the kernel', () => {
  expect(() => assertProfileRows([row], 'author')).not.toThrow()
  expect(() => assertProfileRows([row], row.path)).not.toThrow()
  expect(() => assertProfileRows([row], 'missing')).toThrow('does not exist')
  expect(() => assertProfileRows([row], '   ')).toThrow('empty')
})
it('rejects ambiguous names and malformed or unauthored results', () => {
  expect(() => assertProfileRows([row, { ...row, path: '/workspace/other.md' }], 'author')).toThrow('ambiguous')
  expect(() => assertProfileRows(null, 'author')).toThrow('invalid')
  expect(() => assertProfileRows([{ fields: row.fields }], 'author')).toThrow('authored path')
})
it.each([{ ready: false, result: [row] }, { type: 'error', message: 'schema failure', result: [row] }])('rejects engine error frames even when they contain a matching row', async frame => {
  await expect(verifyProfile('/workspace', 'author', () => broker({ read: async () => frame }))).rejects.toThrow('cannot be verified')
})
it('requires an available daemon and closes its read-only broker', async () => {
  const close = vi.fn()
  await expect(verifyProfile('/workspace', 'author', () => broker({ close }))).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledOnce()
  await expect(verifyProfile('/workspace', 'author', () => broker({ available: () => false }))).rejects.toThrow('unavailable')
})
it('propagates transport failure rather than validating a bare unrestricted session', async () => {
  await expect(verifyProfile('/workspace', 'author', () => broker({ read: async () => { throw new Error('connection lost') } }))).rejects.toThrow('connection lost')
})
