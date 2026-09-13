// Adapter-local existence/readiness guard. It does not reproduce the kernel's hook policy.
import { createEngineBroker, type EngineBroker } from '@arsumbris/au-mcp'
import { withGenerationBroker } from './generation-broker.ts'

/** Match the shared kernel's locator semantics: fields.name or authored path. */
export function assertProfileRows(rows: unknown, profile: string): void {
  if (!profile.trim()) throw new Error('An explicit profile locator must not be empty')
  if (!Array.isArray(rows)) throw new Error('Engine returned an invalid agent-profile discovery result')
  const matches = rows.filter(row => row && typeof row === 'object' && (row.fields?.name === profile || row.path === profile))
  if (matches.length === 0) throw new Error(`Agent profile ${JSON.stringify(profile)} does not exist in this workspace`)
  if (matches.length !== 1) throw new Error(`Agent profile ${JSON.stringify(profile)} is ambiguous; use its authored file path`)
  if (typeof matches[0].path !== 'string' || !matches[0].path.trim()) throw new Error('Selected agent profile has no authored path')
}

/** A read-only preflight; kernel configuration-load attestation requires a shared API change. */
export async function verifyProfile(entry: string, profile: string, create: (entry: string) => EngineBroker = createEngineBroker): Promise<void> {
  await withGenerationBroker(entry, async broker => {
    const frame = await broker.read('instances_of', { type: 'agent-profile' }, 8_000)
    if (frame.type === 'error' || frame.ready === false) throw new Error(`Agent profile cannot be verified: ${String(frame.message ?? 'engine not ready')}`)
    assertProfileRows(frame.result, profile)
  }, create)
}
