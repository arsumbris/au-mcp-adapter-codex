#!/usr/bin/env node
// Print one host-consumable launch descriptor. The runner executes the same path for resume.
import { LAUNCH_ENV } from '@arsumbris/au-mcp-sdk'
import { prepareLaunch } from '../src/launch.ts'
import { parseLaunchArguments } from '../src/launch-args.ts'
try {
  const options = parseLaunchArguments(process.argv.slice(2), process.env[LAUNCH_ENV.WORKSPACE])
  process.stdout.write(`${JSON.stringify(await prepareLaunch(options))}\n`)
} catch (error) {
  process.stderr.write(`launch failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
