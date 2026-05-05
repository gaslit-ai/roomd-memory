import type { ServerOptions } from 'socket.io'
import { makeIdentitySchemas } from '../shared/identity'
import type { IdentityLimits } from '../shared/limits'
import type { ToolAggregator } from '../tools/aggregator'
import { McpToolAdapter, type McpAuthInput } from './adapters/mcp'
import type { McpToolNames } from './adapters/mcp/defaults'
import { SocketIoAdapter, type SocketIoAuthInput } from './adapters/socketio'
import type { SocketIoEventNames } from './adapters/socketio/defaults'
import type { Authenticator } from './adapters/types'
import { Dispatcher } from './core/dispatcher'
import { createUlidGenerator, type IdGenerator } from './core/id'
import { InMemoryBus } from './core/in-memory-bus'
import { DEFAULT_COMMS_LIMITS, type CommsLimits } from './limits'
import { makeEnvelopeSchemas } from './schemas/envelope'
import {
  PayloadRegistry,
  type PayloadDefinition,
} from './schemas/registry'
import { makeToolSchemas } from './schemas/tools'

export interface SocketIoModuleConfig {
  readonly port: number
  readonly path?: string
  readonly namespace?: string
  readonly cors?: ServerOptions['cors']
  readonly events?: Partial<SocketIoEventNames>
  readonly authenticator: Authenticator<SocketIoAuthInput>
}

export interface McpModuleConfig {
  readonly authenticator: Authenticator<McpAuthInput>
  readonly toolNames?: Partial<McpToolNames>
}

export interface CommsModuleConfig {
  readonly payloads: readonly PayloadDefinition[]
  readonly identity?: { readonly limits?: IdentityLimits }
  readonly limits?: CommsLimits
  readonly socketio?: SocketIoModuleConfig
  readonly mcp?: McpModuleConfig
  readonly idGenerator?: IdGenerator
  readonly clock?: () => Date
}

export interface CommsModule {
  registerTools(aggregator: ToolAggregator): void
  start(): Promise<void>
  stop(): Promise<void>
}

export function createCommsModule(config: CommsModuleConfig): CommsModule {
  const commsLimits = config.limits ?? DEFAULT_COMMS_LIMITS

  const identity = makeIdentitySchemas(config.identity?.limits)
  const envelope = makeEnvelopeSchemas(identity, commsLimits)
  const tools = makeToolSchemas(envelope, commsLimits)

  const registry = new PayloadRegistry(envelope)
  for (const def of config.payloads) registry.register(def)

  const idGenerator = config.idGenerator ?? createUlidGenerator()

  const bus = new InMemoryBus(commsLimits)
  const dispatcher = new Dispatcher({
    registry,
    bus,
    recvInputSchema: tools.RecvInput,
    limits: commsLimits,
    idGenerator,
    clock: config.clock,
  })

  const context = { dispatcher }

  const socketio = config.socketio
    ? new SocketIoAdapter({
        port: config.socketio.port,
        path: config.socketio.path,
        namespace: config.socketio.namespace,
        cors: config.socketio.cors,
        events: config.socketio.events,
        authenticator: config.socketio.authenticator,
        context,
        identity,
      })
    : undefined

  const mcp = config.mcp
    ? new McpToolAdapter({
        authenticator: config.mcp.authenticator,
        registry,
        tools,
        context,
        identity,
        idGenerator,
        limits: commsLimits,
        toolNames: config.mcp.toolNames,
      })
    : undefined

  return {
    registerTools(aggregator: ToolAggregator): void {
      if (!mcp) {
        throw new Error('MCP adapter is not enabled in this comms module')
      }
      mcp.register(aggregator)
    },
    async start(): Promise<void> {
      if (socketio) await socketio.start()
    },
    async stop(): Promise<void> {
      if (socketio) await socketio.stop()
    },
  }
}

export type { PayloadDefinition } from './schemas/registry'
export type {
  AuthenticatedClaims,
  Authenticator,
} from './adapters/types'
export type { SocketIoAuthInput } from './adapters/socketio'
export type { McpAuthInput } from './adapters/mcp'
