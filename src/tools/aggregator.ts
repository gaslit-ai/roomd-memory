import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export interface ToolCallExtra {
  readonly authInfo?: unknown
  readonly sessionId?: string
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

export interface ToolHandlerResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: TInput
  readonly outputSchema?: TOutput
  readonly annotations?: ToolAnnotations
  readonly handler: (
    args: z.infer<TInput>,
    extra: ToolCallExtra,
  ) => ToolHandlerResult | Promise<ToolHandlerResult>
}

interface CompiledTool {
  readonly def: ToolDefinition
  readonly described: Record<string, unknown>
}

export class ToolAggregator {
  private readonly tools = new Map<string, CompiledTool>()

  register<TInput extends z.ZodType, TOutput extends z.ZodType>(
    def: ToolDefinition<TInput, TOutput>,
  ): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`)
    }
    this.tools.set(def.name, {
      def: def as ToolDefinition,
      described: describe(def as ToolDefinition),
    })
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): readonly string[] {
    return [...this.tools.keys()]
  }

  bind(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.tools.values()].map((t) => t.described),
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params
      const tool = this.tools.get(name)
      if (!tool) return errorResult(`unknown tool: ${name}`)
      const parsed = tool.def.inputSchema.safeParse(args ?? {})
      if (!parsed.success) return errorResult(z.prettifyError(parsed.error))
      try {
        const result = await tool.def.handler(
          parsed.data,
          extra as ToolCallExtra,
        )
        return result as unknown as Record<string, unknown>
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err))
      }
    })
  }
}

function describe(def: ToolDefinition): Record<string, unknown> {
  // Target draft-07: the MCP SDK's default AjvJsonSchemaValidator uses a vanilla
  // Ajv instance with no 2020-12 meta-schema registered, so schemas that declare
  // $schema: ".../draft/2020-12/schema" (Zod 4's default) fail to compile with
  // "no schema with key or ref ...draft/2020-12/schema" before our handler runs.
  const inputSchema = ensureObjectSchema(
    z.toJSONSchema(def.inputSchema, {
      io: 'input',
      target: 'draft-7',
    }) as Record<string, unknown>,
  )
  const outputSchema = def.outputSchema
    ? ensureObjectSchema(
        z.toJSONSchema(def.outputSchema, {
          io: 'output',
          target: 'draft-7',
        }) as Record<string, unknown>,
      )
    : undefined
  const out: Record<string, unknown> = { name: def.name, inputSchema }
  if (def.title !== undefined) out.title = def.title
  if (def.description !== undefined) out.description = def.description
  if (outputSchema !== undefined) out.outputSchema = outputSchema
  if (def.annotations !== undefined) out.annotations = { ...def.annotations }
  return out
}

// MCP requires top-level `type: 'object'` on inputSchema/outputSchema
// (CallToolRequest validation rejects bare anyOf/oneOf roots). Zod 4's
// toJSONSchema emits unions without a top-level type, so add one.
function ensureObjectSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === 'object') return schema
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    return { type: 'object', ...schema }
  }
  return schema
}

function errorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}
