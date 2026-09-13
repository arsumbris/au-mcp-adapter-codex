#!/usr/bin/env node
import { readPayload, reportTurnEnd } from '../src/bridge.ts'
import { liftRollout } from '../src/lift.ts'
const payload = await readPayload(process.stdin)
await liftRollout(payload)
await reportTurnEnd(payload)
