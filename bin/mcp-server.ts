#!/usr/bin/env node
// Wired launches set AU_MCP_WORKSPACE. The bridge retains nearest-repo discovery for bare use.
import { runMcpServer } from '../src/mcp-server.ts'
import { resolveEntry } from '../src/bridge.ts'

await runMcpServer(resolveEntry(process.cwd()))
