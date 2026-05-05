import { createServer, type Server as HttpServer } from 'node:http'
import {
  Server as SocketIoServer,
  type DefaultEventsMap,
  type ServerOptions,
  type Socket,
} from 'socket.io'
import type { IdentitySchemas } from '../../../shared/identity'
import type { SessionContext, WireMessage } from '../../core/types'
import type {
  AdapterContext,
  AuthenticatedClaims,
  Authenticator,
  CommsAdapter,
} from '../types'
import {
  DEFAULT_SOCKETIO_EVENT_NAMES,
  DEFAULT_SOCKETIO_NAMESPACE,
  type SocketIoEventNames,
} from './defaults'

export interface SocketIoAuthInput {
  readonly token?: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly query: Record<string, string | string[] | undefined>
}

export interface SocketIoAdapterOptions {
  readonly port: number
  readonly path?: string
  readonly namespace?: string
  readonly cors?: ServerOptions['cors']
  readonly events?: Partial<SocketIoEventNames>
  readonly authenticator: Authenticator<SocketIoAuthInput>
  readonly context: AdapterContext
  readonly identity: IdentitySchemas
}

interface InternalSocketData {
  session: SessionContext
}

type AdapterSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  InternalSocketData
>

type AckResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string }

type Ack<T> = (result: AckResult<T>) => void

function withAck<T>(handle: (input: unknown) => T) {
  return (input: unknown, ack?: Ack<T>) => {
    try {
      ack?.({ ok: true, data: handle(input) })
    } catch (err) {
      ack?.({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export class SocketIoAdapter implements CommsAdapter {
  private readonly events: SocketIoEventNames
  private readonly namespace: string
  private io: SocketIoServer | undefined
  private httpServer: HttpServer | undefined

  constructor(private readonly options: SocketIoAdapterOptions) {
    this.events = { ...DEFAULT_SOCKETIO_EVENT_NAMES, ...options.events }
    this.namespace = options.namespace ?? DEFAULT_SOCKETIO_NAMESPACE
  }

  async start(): Promise<void> {
    if (this.io) return
    const httpServer = createServer()
    this.httpServer = httpServer
    const io = new SocketIoServer(httpServer, {
      path: this.options.path,
      cors: this.options.cors,
    })

    const ns = io.of(this.namespace)
    ns.use((socket, next) => {
      this.handshake(socket as AdapterSocket).then(
        () => next(),
        (err: unknown) =>
          next(err instanceof Error ? err : new Error(String(err))),
      )
    })
    ns.on('connection', (socket) => this.onConnection(socket as AdapterSocket))

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        httpServer.removeListener('error', onError)
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(this.options.port)
    })

    this.io = io
  }

  async stop(): Promise<void> {
    const io = this.io
    const httpServer = this.httpServer
    this.io = undefined
    this.httpServer = undefined
    if (!io) return
    httpServer?.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      io.close((err) => (err ? reject(err) : resolve()))
    })
  }

  private async handshake(socket: AdapterSocket): Promise<void> {
    const claims = await this.options.authenticator({
      token: readToken(socket),
      headers: socket.handshake.headers,
      query: socket.handshake.query,
    })
    socket.data.session = this.buildSession(socket, claims)
    this.options.context.dispatcher.attach(socket.data.session)
  }

  private onConnection(socket: AdapterSocket): void {
    const session = socket.data.session
    if (!session) {
      socket.disconnect(true)
      return
    }
    const dispatcher = this.options.context.dispatcher
    socket.on(this.events.send, withAck((input) => dispatcher.send(input, session)))
    socket.on(
      this.events.recv,
      withAck((input) => [...dispatcher.recv(session, input)]),
    )
    socket.on('disconnect', () => dispatcher.detach(session))
  }

  private buildSession(
    socket: AdapterSocket,
    claims: AuthenticatedClaims,
  ): SessionContext {
    const messageEvent = this.events.message
    const identity = this.options.identity
    return {
      id: identity.SessionId.parse(socket.id),
      user: identity.UserId.parse(claims.userId),
      rooms: claims.rooms.map((r) => identity.RoomId.parse(r)),
      emit: (msg: WireMessage) => {
        socket.emit(messageEvent, msg)
      },
      close: () => {
        socket.disconnect(true)
      },
    }
  }
}

function readToken(socket: AdapterSocket): string | undefined {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined
  const candidate = auth?.token
  return typeof candidate === 'string' ? candidate : undefined
}
