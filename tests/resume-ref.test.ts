import { expect, it } from 'vitest'
import { codexResumeRef, parseResumeRef } from '../src/resume-ref.ts'
it('stores logical selections without depending on generated content or coordination paths', () => {
  const env = { CODEX_HOME: '/native', AU_MCP_WORKSPACE: '/workspace', AU_MCP_PROFILE: 'author', AU_CODEX_SELECTION: '{"skills":[],"inject":["repo:context"]}', AU_CODEX_INJECT: '["/disposable/content.md"]' }
  const ref = codexResumeRef('thread-123', env)!
  expect(parseResumeRef(ref)).toEqual({ version: 2, home: '/native', workspace: '/workspace', thread: 'thread-123', selections: { skills: [], inject: ['repo:context'], profile: 'author' } })
  expect(ref).not.toContain('disposable')
})
it.each(['no-json', 'null', '{}', '{"version":1,"runtime":"/old","home":"/home","thread":"ok"}', '{"version":2,"home":"/native","workspace":"/ws","thread":"../bad","selections":{}}'])('rejects invalid recipe %s', value => {
  expect(() => parseResumeRef(value)).toThrow('Invalid Codex resume recipe')
})
