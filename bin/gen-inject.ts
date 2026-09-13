#!/usr/bin/env node
// Materialize selected instructions with the Codex transform. Print directories one per line,
// or discovery JSON with --manifest. Requires a running workspace engine.

import { resolve } from 'node:path'
import { assertSelectedPresent } from '../src/selection.ts'
import { withGenerationBroker } from '../src/generation-broker.ts'

import { injectManifest, materializeInjects } from '@arsumbris/au-mcp'

import { renderInjectTree } from '../src/inject-codex.ts'

const USAGE =
  'usage: gen-inject --workspace <entry> [--manifest] [--inject <owner:name> ...] [--inject-budget <bytes>=256+]\n' +
  '  (entry = the folder-repo the engine was started on)'

function parseWorkspace(argv: string[]): string | null {
  const i = argv.indexOf('--workspace')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  return process.env.AU_MCP_WORKSPACE ?? null
}

/** The `--inject` selection: every value after a `--inject` flag up to the next flag, comma-split. */
function parseSelect(argv: string[]): string[] | undefined {
  const keys: string[] = []
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--inject') continue
    seen = true
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) {
      keys.push(...argv[j].split(',').map((k) => k.trim()).filter(Boolean))
    }
  }
  return seen ? keys : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  for (const arg of argv) {
    if (arg.startsWith('--') && !['--workspace', '--manifest', '--inject', '--inject-budget'].includes(arg)) throw new Error(`Unknown option: ${arg}`)
  }
  const workspace = parseWorkspace(argv)
  if (!workspace) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const entry = resolve(workspace)

  // Manifest mode: enumerate the discovered injects as JSON, write nothing. The host renders
  // its inject picker from this.
  if (argv.includes('--manifest')) {
    process.stdout.write(`${JSON.stringify(await withGenerationBroker(entry, broker => injectManifest(entry, { broker })))}\n`)
    return
  }

  const budgetIndex = argv.indexOf('--inject-budget')
  const budget = budgetIndex < 0 ? undefined : Number(argv[budgetIndex + 1])
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 256)) throw new Error('--inject-budget requires an integer of at least 256 bytes')
  const select = parseSelect(argv)
  const result = await withGenerationBroker(entry, broker => materializeInjects(entry, 'codex', blocks => renderInjectTree(blocks, { budget }), { broker, ...(select !== undefined ? { select } : {}) }))

  assertSelectedPresent(select, result.injects)

  // Report assembly failures before rejecting incomplete generation.
  for (const { path, reason } of result.skipped) {
    process.stderr.write(`gen-inject: skipped ${path} — ${reason}\n`)
  }
  if (result.skipped.length > 0) throw new Error('Selected content could not be materialized; see diagnostics above')
  if (result.collected.length > 0) {
    process.stderr.write(`gen-inject: swept ${result.collected.length} dead-socket gen tree(s)\n`)
  }
  // List instructions omitted by the budget on stderr.
  if (result.dropped.length > 0) {
    process.stderr.write(
      `gen-inject: BUDGET EXCEEDED — ${result.dropped.length} block(s) not injected: ${result.dropped
        .map((d) => d.addr)
        .join(', ')}\n`,
    )
  }

  for (const dir of result.pluginDirs) process.stdout.write(`${dir}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `gen-inject failed: ${message}\n` +
      'Is the engine daemon running on this workspace? The launcher must bring it up first.\n',
  )
  process.exit(1)
})
