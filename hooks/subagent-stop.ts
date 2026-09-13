#!/usr/bin/env node
// This is a CHILD TURN boundary, not the child's session termination.
import { readPayload } from '../src/bridge.ts'
import { completeSubagentTurn } from '../src/lift.ts'
await completeSubagentTurn(await readPayload(process.stdin))
