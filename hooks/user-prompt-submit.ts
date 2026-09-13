#!/usr/bin/env node
// A file mention inlines content outside a tool call. Preserve the existing restricted-session
// prompt guard and record the raw prompt. The daemon owns the native-tool policy.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, sessionGuards } from '../src/bridge.ts'
import { hasFileMention } from '../src/mentions.ts'

const payload = await readPayload(process.stdin)
const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''

if (hasFileMention(prompt) && (await sessionGuards(payload)).denyNative) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'This session is governed: @file mentions bypass the Arsumbris gate (they inline file content untraced, with no tool call). Remove the @ and ask me to read the file — I will use a governed file-reading tool.',
    }),
  )
  process.exit(0)
}

await observeEvent(payload, EventKind.UserPrompt, {
  prompt: payload.prompt ?? null,
  permission_mode: payload.permission_mode ?? null,
})
process.exit(0)
