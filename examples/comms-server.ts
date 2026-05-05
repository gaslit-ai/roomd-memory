import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { brand, type RoomId, type UserId } from '../src/shared/identity'
import { createRoomdServer } from '../src/server'

const DEFAULT_SOCKETIO_PORT = 4310
const DEFAULT_MCP_HTTP_PORT = 4311
const DEFAULT_UI_PORT = 4312
const DEFAULT_ROOM = 'demo'
const DEFAULT_OBSERVER_TOKEN = 'observer'
const SOCKETIO_NAMESPACE = '/comms'
const SHUTDOWN_TIMEOUT_MS = 5000
const CHAT_BODY_MAX_LENGTH = 8000

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_METHOD_NOT_ALLOWED = 405
const HTTP_INTERNAL_ERROR = 500
const JSONRPC_SERVER_ERROR_CODE = -32000
const JSON_CONTENT_TYPE = 'application/json'
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

const PAYLOAD_TYPES = ['chat.text', 'agent.task.update'] as const

const UI_HTML_PATH = join(__dirname, 'comms-ui.html')

const ChatText = z.object({
  body: z.string().max(CHAT_BODY_MAX_LENGTH),
  attachments: z
    .array(z.object({ url: z.string(), mime: z.string() }))
    .optional(),
})

const TaskUpdate = z.object({
  taskId: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  progress: z.number().min(0).max(1).optional(),
})

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function loadUiHtml(
  socketioPort: number,
  room: string,
): Promise<string> {
  const template = await readFile(UI_HTML_PATH, 'utf8')
  return template
    .replace(/__SOCKETIO_URL__/g, `http://localhost:${socketioPort}`)
    .replace(/__SOCKETIO_NAMESPACE__/g, SOCKETIO_NAMESPACE)
    .replace(/__DEFAULT_TOKEN__/g, DEFAULT_OBSERVER_TOKEN)
    .replace(/__DEFAULT_ROOM__/g, room)
    .replace(/__PAYLOAD_TYPES__/g, JSON.stringify(PAYLOAD_TYPES))
}

async function main(): Promise<void> {
  const socketioPort = Number(process.env.PORT ?? DEFAULT_SOCKETIO_PORT)
  const mcpPort = Number(process.env.MCP_PORT ?? DEFAULT_MCP_HTTP_PORT)
  const uiPort = Number(process.env.UI_PORT ?? DEFAULT_UI_PORT)
  const room = process.env.ROOM ?? DEFAULT_ROOM

  const roomd = createRoomdServer({
    name: 'roomd-memory-demo',
    version: '0.1.0',
    comms: {
      payloads: [
        {
          type: 'chat.text',
          schema: ChatText,
          description: 'Plain chat message body, optionally with attachments.',
        },
        {
          type: 'agent.task.update',
          schema: TaskUpdate,
          description: 'Status update for an in-flight agent task.',
        },
      ],
      socketio: {
        port: socketioPort,
        cors: { origin: '*' },
        authenticator: ({ token }) => {
          if (!token) throw new Error('missing auth token')
          return {
            userId: brand<UserId>(token),
            rooms: [brand<RoomId>(room)],
          }
        },
      },
      mcp: {
        authenticator: ({ extra }) => {
          // Identity precedence:
          //   1. X-Agent-Handle HTTP header (set by per-agent launchers)
          //   2. extra.userId (legacy / test injection)
          //   3. fallback default
          const headers = (extra.requestInfo as { headers?: Record<string, unknown> } | undefined)?.headers
          const headerHandle = headers?.['x-agent-handle']
          const handle =
            (typeof headerHandle === 'string' && headerHandle) ||
            (Array.isArray(headerHandle) && typeof headerHandle[0] === 'string' && headerHandle[0]) ||
            (typeof extra.userId === 'string' && extra.userId) ||
            'agent-1'
          return {
            userId: brand<UserId>(handle),
            rooms: [brand<RoomId>(room)],
          }
        },
      },
    },
  })

  await roomd.start()

  const transports = new Map<string, StreamableHTTPServerTransport>()

  const handleMcpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const sessionId = req.headers['mcp-session-id']
    const sid = typeof sessionId === 'string' ? sessionId : undefined

    if (sid && transports.has(sid)) {
      await transports.get(sid)!.handleRequest(req, res)
      return
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (!sid && isInitializeRequest(body)) {
        const transport: StreamableHTTPServerTransport =
          new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string): void => {
              transports.set(id, transport)
            },
          })
        transport.onclose = () => {
          const id = transport.sessionId
          if (id) transports.delete(id)
        }
        const server = roomd.createMcpServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
        return
      }
      res.statusCode = HTTP_BAD_REQUEST
      res.setHeader('content-type', JSON_CONTENT_TYPE)
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: JSONRPC_SERVER_ERROR_CODE,
            message: 'Bad Request: no valid session id',
          },
          id: null,
        }),
      )
      return
    }

    res.statusCode = HTTP_METHOD_NOT_ALLOWED
    res.end()
  }

  const mcpHttp = createHttpServer((req, res) => {
    void handleMcpRequest(req, res).catch((err) => {
      process.stderr.write(`mcp request error: ${String(err)}\n`)
      if (!res.headersSent) {
        res.statusCode = HTTP_INTERNAL_ERROR
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    mcpHttp.once('error', reject)
    mcpHttp.once('listening', () => resolve())
    mcpHttp.listen(mcpPort)
  })

  const uiHtml = await loadUiHtml(socketioPort, room)
  const uiHttp = createHttpServer((req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = HTTP_METHOD_NOT_ALLOWED
      res.end()
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/' || path === '/index.html') {
      res.statusCode = HTTP_OK
      res.setHeader('content-type', HTML_CONTENT_TYPE)
      res.setHeader('cache-control', 'no-store')
      res.end(uiHtml)
      return
    }
    res.statusCode = HTTP_NOT_FOUND
    res.end()
  })

  await new Promise<void>((resolve, reject) => {
    uiHttp.once('error', reject)
    uiHttp.once('listening', () => resolve())
    uiHttp.listen(uiPort)
  })

  process.stdout.write(`socket.io: http://localhost:${socketioPort}${SOCKETIO_NAMESPACE}\n`)
  process.stdout.write(`engine.io handshake path: http://localhost:${socketioPort}/socket.io/\n`)
  process.stdout.write(`mcp (streamable http): http://localhost:${mcpPort}/\n`)
  process.stdout.write(`ui (live feed): http://localhost:${uiPort}/\n`)
  process.stdout.write(`payload types: ${PAYLOAD_TYPES.join(', ')}\n`)
  process.stdout.write(`press Ctrl-C to stop\n`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      process.stdout.write(`\nreceived ${signal} again, forcing exit\n`)
      process.exit(1)
    }
    shuttingDown = true
    process.stdout.write(`\nreceived ${signal}, stopping…\n`)
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()

    uiHttp.closeAllConnections()
    await new Promise<void>((resolve) => uiHttp.close(() => resolve()))
    mcpHttp.closeAllConnections()
    await new Promise<void>((resolve) => mcpHttp.close(() => resolve()))
    for (const transport of transports.values()) {
      await transport.close().catch(() => {})
    }
    transports.clear()
    await roomd.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${String(err instanceof Error ? err.stack ?? err.message : err)}\n`,
  )
  process.exit(1)
})
