import { z } from 'zod'
import { DEFAULT_COMMS_LIMITS, type CommsLimits } from '../limits'
import type { EnvelopeShape } from '../schemas/envelope'
import type { PayloadRegistry } from '../schemas/registry'
import type { MessageBus } from './bus'
import { createUlidGenerator, type IdGenerator } from './id'
import type { SessionContext, WireMessage } from './types'

export interface DispatchResult {
  readonly id: string
  readonly ts: string
  readonly delivered_to: number
}

interface RecvInputShape {
  readonly since?: string
  readonly limit?: number
  readonly type_filter?: readonly string[]
}

export interface DispatcherOptions {
  readonly registry: PayloadRegistry
  readonly bus: MessageBus
  readonly recvInputSchema: z.ZodType
  readonly limits?: CommsLimits
  readonly idGenerator?: IdGenerator
  readonly clock?: () => Date
}

export class EnvelopeValidationError extends Error {
  constructor(public readonly cause: unknown) {
    super('invalid envelope')
    this.name = 'EnvelopeValidationError'
  }
}

export class RecvQueryValidationError extends Error {
  constructor(public readonly cause: unknown) {
    super('invalid recv query')
    this.name = 'RecvQueryValidationError'
  }
}

export class Dispatcher {
  private readonly bus: MessageBus
  private readonly recvInputSchema: z.ZodType
  private readonly sendUnion: z.ZodType
  private readonly limits: CommsLimits
  private readonly idGenerator: IdGenerator
  private readonly clock: () => Date
  private readonly idempotency = new Map<string, DispatchResult>()

  constructor(options: DispatcherOptions) {
    this.bus = options.bus
    this.recvInputSchema = options.recvInputSchema
    this.sendUnion = options.registry.toSendUnion()
    this.limits = options.limits ?? DEFAULT_COMMS_LIMITS
    this.idGenerator = options.idGenerator ?? createUlidGenerator()
    this.clock = options.clock ?? (() => new Date())
  }

  attach(session: SessionContext): void {
    this.bus.attach(session)
  }

  detach(session: SessionContext): void {
    this.bus.detach(session)
  }

  send(envelope: unknown, session: SessionContext): DispatchResult {
    const validated = this.validateEnvelope(envelope)

    const key = validated.client_msg_id
      ? `${session.id}:${validated.client_msg_id}`
      : undefined
    if (key) {
      const cached = this.idempotency.get(key)
      if (cached) return cached
    }

    const id = this.idGenerator.next()
    const ts = this.clock().toISOString()

    let deliveredTo = 0
    for (const room of session.rooms) {
      const message: WireMessage = {
        ...validated,
        id,
        ts,
        sender: session.user,
        session: session.id,
        room,
        delivered_at: ts,
      }
      deliveredTo += this.bus.publish(room, message)
    }

    const result: DispatchResult = { id, ts, delivered_to: deliveredTo }
    if (key) this.recordIdempotent(key, result)
    return result
  }

  recv(session: SessionContext, input: unknown = {}): readonly WireMessage[] {
    const query = this.validateRecvQuery(input)
    return this.bus.recentForSession(session, {
      since: query.since,
      limit: query.limit ?? this.limits.recvLimitDefault,
      typeFilter: query.type_filter,
    })
  }

  private validateEnvelope(envelope: unknown): EnvelopeShape {
    const result = this.sendUnion.safeParse(envelope)
    if (!result.success) throw new EnvelopeValidationError(result.error)
    return result.data as EnvelopeShape
  }

  private validateRecvQuery(input: unknown): RecvInputShape {
    const result = this.recvInputSchema.safeParse(input ?? {})
    if (!result.success) throw new RecvQueryValidationError(result.error)
    return result.data as RecvInputShape
  }

  private recordIdempotent(key: string, result: DispatchResult): void {
    if (this.idempotency.size >= this.limits.idempotencyWindowSize) {
      const oldest = this.idempotency.keys().next().value
      if (oldest !== undefined) this.idempotency.delete(oldest)
    }
    this.idempotency.set(key, result)
  }
}
