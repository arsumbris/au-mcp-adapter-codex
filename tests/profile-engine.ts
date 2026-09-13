// Wire-level engine fixture: real SDK clients and daemon policy, controlled profile rows.
import { createServer, type Socket } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { engineSocketPath } from '@arsumbris/au-mcp'
import { WIRE_SCHEMA_VERSION } from '@arsumbris/au-engine-sdk/wire'

export async function profileEngine(workspace: string) {
  const rows: Array<{ path: string; fields: Record<string, unknown> }> = []
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (buffer.length < length + 4) break
        const request = JSON.parse(buffer.subarray(4, length + 4).toString())
        buffer = buffer.subarray(length + 4)
        if (!request.read) continue
        const result = request.read === 'instances_of' && request.type === 'agent-profile' ? rows : []
        const body = Buffer.from(JSON.stringify({ type: 'response', ready: true, version: 1, schema_version: WIRE_SCHEMA_VERSION, id: request.id, result: { [request.read]: result } }))
        const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
        socket.write(Buffer.concat([header, body]))
      }
    })
  })
  const path = engineSocketPath(workspace)
  await mkdir(dirname(path), { recursive: true })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  return {
    add(name: string, tools: string[]) {
      rows.push({ path: join(workspace, `${rows.length}.yaml`), fields: { name, tools: tools.map(tool => `[[mcp.tool.${tool}]]`) } })
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
