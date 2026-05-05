import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { io as ioClient } from 'socket.io-client'
import { z } from 'zod'

import { brand, type RoomId, type UserId } from '../shared/identity.js'
import { createRoomdServer, type RoomdServer } from '../server.js'

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('no port assigned')))
      }
    })
  })
}

const ChatText = z.object({
  body: z.string().max(1000),
  attachments: z
    .array(
      z.object({
        url: z.string(),
        mime: z.string(),
      }),
    )
    .optional(),
})

const TaskUpdate = z.object({
  taskId: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  progress: z.number().min(0).max(1).optional(),
})

const ROOM = brand<RoomId>('room-1')

interface SocketAck<T> {
  ok: boolean
  data?: T
  error?: string
}

async function ackOnce<T>(
  socket: ReturnType<typeof ioClient>,
  event: string,
  payload: unknown,
): Promise<SocketAck<T>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack: SocketAck<T>) => resolve(ack))
  })
}

async function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs = 1000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = predicate()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timed out')
}

describe('comms module smoke', () => {
  let port: number
  let url: string
  let roomd: RoomdServer
  let mcpClient: Client

  before(async () => {
    port = await findFreePort()
    url = `http://localhost:${port}/comms`

    roomd = createRoomdServer({
      name: 'test-roomd',
      version: '0.0.0',
      comms: {
        payloads: [
          {
            type: 'chat.text',
            schema: ChatText,
            description: 'A chat message body, optionally with attachments.',
          },
          {
            type: 'agent.task.update',
            schema: TaskUpdate,
            description: 'Status update for an in-flight agent task.',
          },
        ],
        socketio: {
          port,
          cors: { origin: '*' },
          authenticator: ({ token }) => {
            if (!token) throw new Error('missing token')
            return { userId: brand<UserId>(token), rooms: [ROOM] }
          },
        },
        mcp: {
          authenticator: ({ extra }) => ({
            userId: brand<UserId>((extra.userId as string) ?? 'agent-1'),
            rooms: [ROOM],
          }),
        },
      },
    })

    await roomd.start()

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const mcpServer = roomd.createMcpServer()
    mcpClient = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([
      mcpServer.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ])
  })

  after(async () => {
    await mcpClient.close()
    await roomd.stop()
  })

  it('socket.io: alice sends, both alice and bob receive', async () => {
    const alice = ioClient(url, {
      auth: { token: 'alice' },
      transports: ['websocket'],
    })
    const bob = ioClient(url, {
      auth: { token: 'bob' },
      transports: ['websocket'],
    })

    await Promise.all([
      new Promise<void>((r) => alice.on('connect', () => r())),
      new Promise<void>((r) => bob.on('connect', () => r())),
    ])

    const aliceReceived: Array<Record<string, unknown>> = []
    const bobReceived: Array<Record<string, unknown>> = []
    alice.on('message', (m: Record<string, unknown>) => aliceReceived.push(m))
    bob.on('message', (m: Record<string, unknown>) => bobReceived.push(m))

    const ack = await ackOnce<{
      id: string
      ts: string
      delivered_to: number
    }>(alice, 'send', {
      type: 'chat.text',
      payload: { body: 'hello world' },
    })

    assert.equal(ack.ok, true)
    assert.ok(ack.data?.id)
    assert.equal(ack.data.delivered_to, 2, 'alice + bob both attached to room-1')

    await waitFor(() =>
      aliceReceived.length === 1 && bobReceived.length === 1
        ? true
        : undefined,
    )

    const aliceMsg = aliceReceived[0] as Record<string, unknown>
    assert.equal((aliceMsg.payload as { body: string }).body, 'hello world')
    assert.equal(aliceMsg.sender, 'alice')
    assert.equal(aliceMsg.room, ROOM)
    assert.equal(typeof aliceMsg.id, 'string')
    assert.equal(typeof aliceMsg.ts, 'string')

    alice.disconnect()
    bob.disconnect()
  })

  it('socket.io: recv returns recent messages', async () => {
    const charlie = ioClient(url, {
      auth: { token: 'charlie' },
      transports: ['websocket'],
    })
    await new Promise<void>((r) => charlie.on('connect', () => r()))

    const ack = await ackOnce<unknown[]>(charlie, 'recv', { limit: 10 })

    assert.equal(ack.ok, true)
    assert.ok(Array.isArray(ack.data))
    assert.ok(ack.data.length >= 1, 'recent buffer has at least the prior send')

    charlie.disconnect()
  })

  it('socket.io: validation rejects unknown type', async () => {
    const dave = ioClient(url, {
      auth: { token: 'dave' },
      transports: ['websocket'],
    })
    await new Promise<void>((r) => dave.on('connect', () => r()))

    const ack = await ackOnce<unknown>(dave, 'send', {
      type: 'unknown.type',
      payload: { foo: 'bar' },
    })

    assert.equal(ack.ok, false)
    assert.equal(typeof ack.error, 'string')

    dave.disconnect()
  })

  it('mcp: one tool per registered payload type, each fully renderable', async () => {
    const list = await mcpClient.listTools()
    const names = list.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'comms.recv',
      'comms.send.agent.task.update',
      'comms.send.chat.text',
    ])

    const chatTool = list.tools.find((t) => t.name === 'comms.send.chat.text')
    assert.ok(chatTool)
    const chatSchema = chatTool.inputSchema as Record<string, unknown>
    assert.equal(chatSchema.type, 'object')
    const chatProps = chatSchema.properties as Record<
      string,
      Record<string, unknown>
    >
    assert.ok(chatProps.payload, 'has nested `payload` object')
    assert.equal(chatProps.payload.type, 'object')
    const payloadProps = chatProps.payload.properties as Record<string, unknown>
    assert.deepEqual(
      Object.keys(payloadProps).sort(),
      ['attachments', 'body'],
      'payload exposes the actual chat fields',
    )
    assert.ok(!('type' in chatProps), 'no discriminator field on agent surface')
    for (const field of ['reply_to', 'client_msg_id', 'meta']) {
      assert.ok(chatProps[field], `has \`${field}\` envelope field`)
    }

    const taskTool = list.tools.find(
      (t) => t.name === 'comms.send.agent.task.update',
    )
    assert.ok(taskTool)
    const taskSchema = taskTool.inputSchema as Record<string, unknown>
    const taskProps = taskSchema.properties as Record<
      string,
      Record<string, unknown>
    >
    assert.ok(taskProps.payload, 'has nested `payload` object')
    const taskPayloadProps = taskProps.payload.properties as Record<
      string,
      unknown
    >
    assert.deepEqual(
      Object.keys(taskPayloadProps).sort(),
      ['progress', 'status', 'taskId'],
      'payload exposes the actual task fields',
    )

    assert.deepEqual(chatTool.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
    const recv = list.tools.find((t) => t.name === 'comms.recv')
    assert.ok(recv)
    assert.deepEqual(recv.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  it('mcp: comms.send.chat.text accepts a typed payload', async () => {
    const result = await mcpClient.callTool({
      name: 'comms.send.chat.text',
      arguments: {
        payload: {
          body: 'from mcp agent',
          attachments: [
            { url: 'https://example.com/a.png', mime: 'image/png' },
          ],
        },
      },
    })
    const structured = result.structuredContent as Record<string, unknown>
    assert.ok(structured?.id, 'send returned id')
    assert.ok(structured.ts, 'send returned ts')
    assert.equal(typeof structured.delivered_to, 'number')
  })

  it('mcp: comms.recv returns the prior typed message', async () => {
    const result = await mcpClient.callTool({
      name: 'comms.recv',
      arguments: { limit: 50 },
    })
    const structured = result.structuredContent as Record<string, unknown>
    assert.ok(Array.isArray(structured.messages))
    const messages = structured.messages as Array<Record<string, unknown>>
    const fromMcp = messages.find(
      (m) =>
        (m.payload as { body?: string } | undefined)?.body === 'from mcp agent',
    )
    assert.ok(fromMcp, 'mcp-sent message present in recv')
    assert.equal(fromMcp?.type, 'chat.text', 'envelope type stamped server-side')
  })

  it('mcp: empty optional-array rows from the inspector are stripped before validation', async () => {
    const result = await mcpClient.callTool({
      name: 'comms.send.chat.text',
      arguments: {
        payload: {
          body: 'no attachments meant',
          attachments: [{}],
        },
      },
    })
    assert.notEqual(
      result.isError,
      true,
      'empty attachment row should not fail validation',
    )
    const structured = result.structuredContent as Record<string, unknown>
    assert.ok(structured?.id, 'message dispatched normally')
  })

  it('mcp: comms.send.agent.task.update rejects an out-of-enum status', async () => {
    const result = await mcpClient.callTool({
      name: 'comms.send.agent.task.update',
      arguments: {
        payload: { taskId: 'x', status: 'not-a-status' },
      },
    })
    assert.equal(result.isError, true, 'invalid status should error')
  })

  it('mcp: unknown tool name is rejected', async () => {
    const result = await mcpClient.callTool({
      name: 'comms.send.not.a.real.type',
      arguments: { payload: {} },
    })
    assert.equal(result.isError, true, 'unknown tool should error')
  })
})
