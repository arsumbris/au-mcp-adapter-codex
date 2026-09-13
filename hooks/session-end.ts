#!/usr/bin/env node
// Codex clamps this hook to three seconds. Keep a safety margin, including stalled stdin/connect.
import { readPayload } from '../src/bridge.ts'
import { finalizeSession } from '../src/lift.ts'
const deadline = Date.now() + 2200
const watchdog = setTimeout(() => {
  process.stderr.write('au-codex: final capture exceeded shutdown budget; the transcript remains available for resume.\n')
  process.exit(0)
}, 2400)
try { await finalizeSession(await readPayload(process.stdin), deadline) }
finally { clearTimeout(watchdog) }
