import { describe, expect, it, vi } from 'vitest'
import { DaemonConnectionError, type DaemonClient, type ToolManifest, type DaemonTransport } from '@arsumbris/au-mcp-sdk'
import { codexThreadId, createMcpGateway as createGateway, createSocketDaemonClient } from '../src/mcp-server.ts'

const createMcpGateway = (options: Parameters<typeof createGateway>[0]) => createGateway({ recoverStartup: async () => undefined, openSession: async (client, info) => { await client.sessionOpen(info) }, ...options })
const parent = '00000000-0000-4000-8000-000000000001'
const child = '00000000-0000-4000-8000-000000000002'
const foreign = '00000000-0000-4000-8000-000000000003'
const meta = (thread_id: string) => ({ callId: 'call-1', 'x-codex-turn-metadata': { thread_id } })
const manifest = (name: string): ToolManifest => ({ id: `mcp.${name}`, kind: 'tool', name, contractVersion: 0 })
function daemon(names = ['read_file']) {
  return {
    listCapabilities: vi.fn(async () => ({ callables: names.map(manifest), redirects: [] })),
    sessionOpen: vi.fn(async () => ({ contractVersion: 0 })),
    invoke: vi.fn(async () => ({ result: 'done' })),
    dispose: vi.fn(),
  }
}
function gateway(client: ReturnType<typeof daemon>) {
  return createMcpGateway({ workspace: '/vault', handle: 'launch-1',
    connect: async () => client as unknown as DaemonClient,
    assertMembership: session => { if (![parent, child].includes(session)) throw new Error('Thread does not belong to this launch') },
  })
}

describe('Codex MCP thread identity', () => {
  it('reads the native metadata object, rejecting guesses and tool-argument identities', () => {
    expect(codexThreadId(meta(parent))).toBe(parent)
    for (const value of [undefined, {}, { thread_id: parent }, { 'x-codex-turn-metadata': JSON.stringify({ thread_id: parent }) }, meta('../foreign')]) {
      expect(() => codexThreadId(value)).toThrow()
    }
  })
  it('attributes simultaneous parent and child calls to their actual sessions without a shared binding', async () => {
    const client = daemon()
    const g = gateway(client)
    await Promise.all([g.callTool('read_file', {}, meta(parent)), g.callTool('read_file', {}, meta(child)), g.callTool('read_file', {}, meta(parent))])
    expect(client.invoke.mock.calls.map(call => (call as unknown[])[0])).toEqual([parent, child, parent])
    for (const call of client.sessionOpen.mock.calls) expect((call as unknown[])[0]).not.toHaveProperty('handle')
  })
  it('rejects an unregistered thread, missing launch handle, or missing metadata before contacting the daemon', async () => {
    const client = daemon()
    const g = gateway(client)
    expect((await g.callTool('read_file', { thread_id: parent }, undefined)).isError).toBe(true)
    expect((await g.callTool('read_file', {}, meta(foreign))).isError).toBe(true)
    const bare = createMcpGateway({ workspace: '/vault', connect: async () => client as unknown as DaemonClient })
    expect(JSON.stringify(await bare.callTool('read_file', {}, meta(parent)))).toContain('AU_MCP_SESSION')
    expect(client.invoke).not.toHaveBeenCalled()
    expect(client.listCapabilities).not.toHaveBeenCalled()
  })
})

describe('MCP daemon lifecycle', () => {
  it('recovers an initially absent daemon when tools are listed and announces the new catalogue', async () => {
    const client = daemon()
    let available = false
    const changed = vi.fn()
    const g = createMcpGateway({ workspace: '/vault', connect: async () => available ? client as unknown as DaemonClient : null, onToolsChanged: changed })
    expect(await g.listTools()).toEqual({ tools: [] })
    available = true
    expect((await g.listTools()).tools.map(t => t.name)).toEqual(['read_file'])
    expect(changed).toHaveBeenCalledOnce()
    await g.listTools()
    expect(changed).toHaveBeenCalledOnce()
  })
  it('refreshes capabilities after startup and refuses tools removed by the daemon', async () => {
    const client = daemon(['read_file'])
    const g = gateway(client)
    await g.listTools()
    client.listCapabilities.mockResolvedValue({ callables: [manifest('write_file')], redirects: [] })
    expect((await g.listTools()).tools.map(t => t.name)).toEqual(['write_file'])
    expect(JSON.stringify(await g.callTool('read_file', {}, meta(parent)))).toContain('not available')
    expect(client.invoke).not.toHaveBeenCalled()
  })
  it.each(['connection-lost', 'timeout'] as const)('does not repeat a possibly completed mutation after %s', async code => {
    const client = daemon(['write_file'])
    let writes = 0
    client.invoke.mockImplementation(async () => { writes++; throw new DaemonConnectionError(code, 'reply lost') })
    const g = gateway(client)
    const response = await g.callTool('write_file', { text: 'hello' }, meta(parent))
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('outcome is unknown')
    expect(writes).toBe(1)
    expect(client.invoke).toHaveBeenCalledOnce()
    expect(client.dispose).toHaveBeenCalledOnce()
  })
  it('uses the profile for discovery and delegates invocation permissions to the daemon', async () => {
    const client = daemon()
    const g = createMcpGateway({ workspace: '/vault', handle: 'launch', profile: 'profile',
      connect: async () => client as unknown as DaemonClient, assertMembership: () => {},
    })
    await g.callTool('read_file', {}, meta(parent))
    expect(client.listCapabilities).toHaveBeenCalledWith(undefined, 'profile')
    expect(client.invoke).toHaveBeenCalledWith(parent, 'mcp.read_file', {})
    expect(client.sessionOpen).toHaveBeenCalledWith(expect.objectContaining({ session: parent, profile: 'profile' }))
  })
  it('returns recovered startup context without invoking, then admits a later request after delivery', async () => {
    const client = daemon()
    let delivered = false
    const g = createMcpGateway({ workspace: '/vault', handle: 'launch',
      connect: async () => client as unknown as DaemonClient, assertMembership: () => {},
      recoverStartup: async () => delivered ? undefined : { identity: { workspace: '/vault', session: parent, handle: 'launch' }, generation: 'run', context: 'Read these recovered instructions', required: true },
    })
    const first = await g.callTool('read_file', {}, meta(parent), () => { delivered = true })
    expect(JSON.stringify(first)).toContain('Read these recovered instructions')
    expect(first.isError).toBe(true)
    expect(client.invoke).not.toHaveBeenCalled()
    expect((await g.callTool('read_file', {}, meta(parent))).isError).toBeFalsy()
    expect(client.invoke).toHaveBeenCalledOnce()
  })
  it('does not invoke when session registration fails', async () => {
    const client = daemon()
    client.sessionOpen.mockRejectedValue(new Error('profile unavailable'))
    expect(JSON.stringify(await gateway(client).callTool('read_file', {}, meta(parent)))).toContain('no tool was invoked')
    expect(client.invoke).not.toHaveBeenCalled()
  })
})


describe('socket lifecycle', () => {
  it('rejects an outstanding call immediately on disconnect, even with the lifecycle observer installed', async () => {
    let onClose: ((reason?: Error) => void) | undefined
    const transport: DaemonTransport & { close(): void } = {
      send: () => {}, receive: () => () => {},
      onClose: callback => { onClose = callback }, close: () => onClose?.(),
    }
    const disconnected = vi.fn()
    const client = createSocketDaemonClient(transport, disconnected)
    const result = client.invoke(parent, 'mcp.write_file', {})
    const rejected = expect(result).rejects.toMatchObject({ code: 'connection-lost' })
    client.dispose()
    await rejected
    expect(disconnected).toHaveBeenCalledOnce()
  })
})


describe('bounded readiness without shortening tool execution', () => {
  it('closes a silent discovery connection within its own deadline without retrying the wedge', async () => {
    vi.useFakeTimers()
    try {
      const client = daemon()
      client.listCapabilities.mockImplementation(() => new Promise(() => {}))
      const connect = vi.fn(async () => client as unknown as DaemonClient)
      const g = createMcpGateway({ workspace: '/vault', connect, readinessTimeoutMs: 80 })
      const listed = g.listTools()
      await vi.advanceTimersByTimeAsync(80)
      expect(await listed).toEqual({ tools: [] })
      expect(connect).toHaveBeenCalledOnce()
      expect(client.dispose).toHaveBeenCalledOnce()
      expect(g.connected).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('keeps reconnect attempts within one discovery budget', async () => {
    vi.useFakeTimers()
    try {
      const first = daemon()
      const second = daemon()
      first.listCapabilities.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new DaemonConnectionError('connection-lost', 'restart')), 60)))
      second.listCapabilities.mockImplementation(() => new Promise(() => {}))
      const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
      const g = createMcpGateway({ workspace: '/vault', connect, readinessTimeoutMs: 80 })
      const listed = g.listTools()
      await vi.advanceTimersByTimeAsync(80)
      expect(await listed).toEqual({ tools: [] })
      expect(connect).toHaveBeenCalledTimes(2)
      expect(first.dispose).toHaveBeenCalledOnce()
      expect(second.dispose).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('does not invoke a tool when session registration exceeds its deadline', async () => {
    vi.useFakeTimers()
    try {
      const client = daemon()
      client.sessionOpen.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('Session initialization timed out')), 80)))
      const g = createMcpGateway({ workspace: '/vault', handle: 'launch', readinessTimeoutMs: 80,
        connect: async () => client as unknown as DaemonClient, assertMembership: () => {},
      })
      const called = g.callTool('read_file', {}, meta(parent))
      await vi.advanceTimersByTimeAsync(80)
      expect(JSON.stringify(await called)).toContain('no tool was invoked')
      expect(client.invoke).not.toHaveBeenCalled()
      expect(client.dispose).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('lets an invocation outlive the readiness deadline', async () => {
    vi.useFakeTimers()
    try {
      const client = daemon()
      client.invoke.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ result: 'done' }), 100)))
      const g = createMcpGateway({ workspace: '/vault', handle: 'launch', readinessTimeoutMs: 80,
        connect: async () => client as unknown as DaemonClient, assertMembership: () => {},
      })
      const called = g.callTool('read_file', {}, meta(parent))
      await vi.advanceTimersByTimeAsync(100)
      expect((await called).isError).toBeFalsy()
      expect(client.dispose).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
