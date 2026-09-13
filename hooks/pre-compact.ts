#!/usr/bin/env node
// Capture the visible tail before reporting compaction.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent } from '../src/bridge.ts'
import { liftRollout } from '../src/lift.ts'

const payload = await readPayload(process.stdin)
await liftRollout(payload)
await observeEvent(payload, EventKind.Compaction, {
  trigger: payload.trigger ?? null,
  custom_instructions: payload.custom_instructions ?? null,
})
process.exit(0)
