import { z } from 'zod'
import { brand, type SessionId } from '../../../shared/identity'
import type {
  ToolAggregator,
  ToolCallExtra,
} from '../../../tools/aggregator'
import type { SessionContext, WireMessage } from '../../core/types'
import { DEFAULT_COMMS_LIMITS, type CommsLimits } from '../../limits'
import { ULID_REGEX } from '../../schemas/constants'
import type { PayloadDefinition, PayloadRegistry } from '../../schemas/registry'
import type { ToolSchemas } from '../../schemas/tools'
import type {
  AdapterContext,
  AuthenticatedClaims,
  Authenticator,
} from '../types'
import { DEFAULT_MCP_TOOL_NAMES, type McpToolNames } from './defaults'

const SEND_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
})

const RECV_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
})

export interface McpAuthInput {
  readonly authInfo?: unknown
  readonly extra: ToolCallExtra
}

export interface McpToolAdapterOptions {
  readonly authenticator: Authenticator<McpAuthInput>
  readonly registry: PayloadRegistry
  readonly tools: ToolSchemas
  readonly context: AdapterContext
  readonly limits?: CommsLimits
  readonly toolNames?: Partial<McpToolNames>
}

export class McpToolAdapter {
  private readonly authenticator: Authenticator<McpAuthInput>
  private readonly registry: PayloadRegistry
  private readonly toolSchemas: ToolSchemas
  private readonly context: AdapterContext
  private readonly toolNames: McpToolNames
  private readonly limits: CommsLimits

  constructor(options: McpToolAdapterOptions) {
    this.authenticator = options.authenticator
    this.registry = options.registry
    this.toolSchemas = options.tools
    this.context = options.context
    this.toolNames = { ...DEFAULT_MCP_TOOL_NAMES, ...options.toolNames }
    this.limits = options.limits ?? DEFAULT_COMMS_LIMITS
  }

  register(aggregator: ToolAggregator): void {
    if (this.registry.size() === 0) {
      throw new Error(
        'cannot register comms.send tools: no payload types registered',
      )
    }
    for (const type of this.registry.types()) {
      const def = this.registry.get(type)
      if (!def) continue
      this.registerSendTool(aggregator, def)
    }
    this.registerRecvTool(aggregator)
  }

  private registerSendTool(
    aggregator: ToolAggregator,
    def: PayloadDefinition,
  ): void {
    const inputSchema = z.object({
      payload: z.preprocess(stripEmptyArrayItems, def.schema),
      reply_to: z
        .string()
        .regex(ULID_REGEX)
        .optional()
        .meta({
          description:
            'Optional. ULID of the message this is replying to, for threading.',
        }),
      client_msg_id: z
        .string()
        .min(this.limits.clientMsgIdMinLength)
        .max(this.limits.clientMsgIdMaxLength)
        .optional()
        .meta({
          description: `Optional. Caller idempotency key (length ${this.limits.clientMsgIdMinLength}-${this.limits.clientMsgIdMaxLength}). Resending with the same id within a session returns the prior result without re-publishing.`,
        }),
      meta: z
        .record(z.string(), z.unknown())
        .optional()
        .meta({
          description: `Optional. Free-form metadata, capped at ${this.limits.metaByteLimit} bytes when JSON-serialized.`,
        }),
    })

    aggregator.register({
      name: `${this.toolNames.send}.${def.type}`,
      title: `Send a ${def.type} message`,
      description:
        def.description ??
        `Send a ${def.type} message to the rooms this session is bound to.`,
      inputSchema,
      outputSchema: this.toolSchemas.SendOutput,
      annotations: SEND_ANNOTATIONS,
      handler: async (args, extra) => {
        const session = await this.deriveSession(extra)
        const result = this.context.dispatcher.send(
          { type: def.type, ...args },
          session,
        )
        return toToolResult({ ...result })
      },
    })
  }

  private registerRecvTool(aggregator: ToolAggregator): void {
    aggregator.register({
      name: this.toolNames.recv,
      title: 'Receive recent comms messages',
      description:
        'Read recent messages addressed to the rooms this session is bound to. Server-stamped fields (id, ts, sender, room, delivered_at) are present on every message.',
      inputSchema: this.toolSchemas.RecvInput,
      outputSchema: this.toolSchemas.RecvOutput,
      annotations: RECV_ANNOTATIONS,
      handler: async (args, extra) => {
        const session = await this.deriveSession(extra)
        const messages = this.context.dispatcher.recv(session, args)
        return toToolResult({ messages: [...messages] })
      },
    })
  }

  private async deriveSession(extra: ToolCallExtra): Promise<SessionContext> {
    const claims: AuthenticatedClaims = await this.authenticator({
      authInfo: extra.authInfo,
      extra,
    })
    return {
      id: brand<SessionId>(claims.userId),
      user: claims.userId,
      rooms: claims.rooms,
      emit: noopEmit,
      close: noopClose,
    }
  }
}

function toToolResult(structured: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

function noopEmit(_message: WireMessage): void {}
function noopClose(_reason?: string): void {}

// Inspector form generators auto-create empty `{}` rows when the user clicks
// into an optional array of objects; submitting without filling them in must
// not fail validation. Drop those placeholder items before parsing.
function stripEmptyArrayItems(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmptyArrayItems).filter((item) => {
      if (item === undefined || item === null) return false
      if (typeof item === 'object' && !Array.isArray(item)) {
        return Object.keys(item as Record<string, unknown>).length > 0
      }
      return true
    })
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripEmptyArrayItems(v)
      if (cleaned !== undefined) out[k] = cleaned
    }
    return out
  }
  return value
}
