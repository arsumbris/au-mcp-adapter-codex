#!/usr/bin/env node
// Materialize selected skills with the Codex transform. Print directories one per line,
// or discovery JSON with --manifest. Requires a running workspace engine.

import { resolve } from 'node:path'
import { assertSelectedPresent } from '../src/selection.ts'
import { withGenerationBroker } from '../src/generation-broker.ts'

import { materialize, skillManifest } from '@arsumbris/au-mcp'

import { codexSkillTransform } from '../src/skills-codex.ts'

const USAGE =
  'usage: gen-skills --workspace <entry> [--manifest] [--skills <owner:name> ...]\n' +
  '  (entry = the folder-repo the engine was started on)'

function parseWorkspace(argv: string[]): string | null {
  const i = argv.indexOf('--workspace')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  // AU_MCP_WORKSPACE is the same entry the MCP-server shim and the launcher already agree on.
  return process.env.AU_MCP_WORKSPACE ?? null
}

/**
 * The `--skills` selection: every value after a `--skills` flag up to the next flag, with
 * each value also comma-split. So `--skills a:b,c:d` and `--skills a:b --skills c:d` and
 * `--skills a:b c:d` all yield the same set. Absent entirely => undefined (all).
 */
function parseSelect(argv: string[]): string[] | undefined {
  const keys: string[] = []
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--skills') continue
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
    if (arg.startsWith('--') && !['--workspace', '--manifest', '--skills'].includes(arg)) throw new Error(`Unknown option: ${arg}`)
  }
  const workspace = parseWorkspace(argv)
  if (!workspace) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const entry = resolve(workspace)

  // Manifest mode: enumerate, print JSON, write nothing.
  if (argv.includes('--manifest')) {
    const manifest = await withGenerationBroker(entry, broker => skillManifest(entry, { broker }))
    process.stdout.write(`${JSON.stringify(manifest)}\n`)
    return
  }

  const select = parseSelect(argv)
  const result = await withGenerationBroker(entry, broker => materialize(entry, 'codex', codexSkillTransform, { broker, ...(select !== undefined ? { select } : {}) }))

  assertSelectedPresent(select, result.skills)

  // Report assembly failures before rejecting incomplete generation.
  for (const { path, reason } of result.skipped) {
    process.stderr.write(`gen-skills: skipped ${path} — ${reason}\n`)
  }
  if (result.skipped.length > 0) throw new Error('Selected content could not be materialized; see diagnostics above')
  if (result.collected.length > 0) {
    process.stderr.write(`gen-skills: swept ${result.collected.length} dead-socket gen tree(s)\n`)
  }

  // Print generated directories one per line; no skills produces empty stdout.
  for (const dir of result.pluginDirs) process.stdout.write(`${dir}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `gen-skills failed: ${message}\n` +
      'Is the engine daemon running on this workspace? The launcher must bring it up first.\n',
  )
  process.exit(1)
})
