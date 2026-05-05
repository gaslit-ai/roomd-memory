import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  createCommsModule,
  type CommsModuleConfig,
  type CommsModule,
} from './comms/server'
import { ToolAggregator } from './tools/aggregator'

const DEFAULT_NAME = 'roomd-memory'
const DEFAULT_VERSION = '0.1.0'

export interface RoomdServerConfig {
  readonly name?: string
  readonly version?: string
  readonly comms?: CommsModuleConfig
}

export interface RoomdServer {
  readonly tools: ToolAggregator
  createMcpServer(): Server
  start(): Promise<void>
  stop(): Promise<void>
}

export function createRoomdServer(config: RoomdServerConfig = {}): RoomdServer {
  const name = config.name ?? DEFAULT_NAME
  const version = config.version ?? DEFAULT_VERSION

  const tools = new ToolAggregator()
  const subsystems: Array<Pick<CommsModule, 'start' | 'stop'>> = []

  if (config.comms) {
    const comms = createCommsModule(config.comms)
    if (config.comms.mcp) comms.registerTools(tools)
    subsystems.push(comms)
  }

  return {
    tools,
    createMcpServer(): Server {
      const server = new Server(
        { name, version },
        { capabilities: { tools: { listChanged: false } } },
      )
      tools.bind(server)
      return server
    },
    async start(): Promise<void> {
      for (const sub of subsystems) await sub.start()
    },
    async stop(): Promise<void> {
      for (const sub of [...subsystems].reverse()) await sub.stop()
    },
  }
}

export type { CommsModuleConfig } from './comms/server'
export type { ToolAggregator } from './tools/aggregator'
