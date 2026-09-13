import { describe, it, expect } from 'vitest'
import { hasFileMention } from '../src/mentions.ts'

describe('hasFileMention', () => {
  it('detects path-like @file mentions', () => {
    expect(hasFileMention('please read @notes/hello.md')).toBe(true)
    expect(hasFileMention('@hello.md')).toBe(true)
    expect(hasFileMention('look at @./src/x.ts now')).toBe(true)
  })

  it('ignores non-file @ uses', () => {
    expect(hasFileMention('hey @alice can you help')).toBe(false) // @name, no path
    expect(hasFileMention('mail me at user@host.com')).toBe(false) // email: @ not at a word boundary
    expect(hasFileMention('use the @decorator pattern')).toBe(false)
    expect(hasFileMention('no mentions here')).toBe(false)
  })
})
