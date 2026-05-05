import { z } from 'zod'
import type { EnvelopeSchemas } from './envelope'

export interface PayloadDefinition<
  TName extends string = string,
  TSchema extends z.ZodType = z.ZodType,
> {
  type: TName
  schema: TSchema
  description?: string
}

type EnvelopeFactory = <T extends z.ZodType>(payload: T) => z.ZodObject

export class PayloadRegistry {
  private readonly defs = new Map<string, PayloadDefinition>()

  constructor(private readonly schemas: EnvelopeSchemas) {}

  register<TName extends string, TSchema extends z.ZodType>(
    def: PayloadDefinition<TName, TSchema>,
  ): this {
    if (this.defs.has(def.type)) {
      throw new Error(`payload type already registered: ${def.type}`)
    }
    this.defs.set(def.type, def)
    return this
  }

  get(type: string): PayloadDefinition | undefined {
    return this.defs.get(type)
  }

  has(type: string): boolean {
    return this.defs.has(type)
  }

  types(): readonly string[] {
    return [...this.defs.keys()]
  }

  size(): number {
    return this.defs.size
  }

  toSendUnion(): z.ZodType {
    return this.buildUnion(this.schemas.envelopeBase)
  }

  toReceivedUnion(): z.ZodType {
    return this.buildUnion(this.schemas.receivedBase)
  }

  private buildUnion(factory: EnvelopeFactory): z.ZodType {
    const branches = [...this.defs.values()].map((def) => {
      const base = factory(def.schema)
      const branch = z.object({
        ...base.shape,
        type: z.literal(def.type),
      })
      return def.description
        ? branch.meta({ description: def.description })
        : branch
    })
    const [first, ...rest] = branches
    if (!first) {
      throw new Error('PayloadRegistry is empty; register at least one type')
    }
    if (rest.length === 0) return first
    return z.discriminatedUnion(
      'type',
      [first, ...rest] as unknown as [z.ZodObject, ...z.ZodObject[]],
    )
  }
}
