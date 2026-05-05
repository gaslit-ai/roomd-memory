import { z } from 'zod'
import { DEFAULT_COMMS_LIMITS, type CommsLimits } from '../limits'
import type { IdentitySchemas } from '../../shared/identity'
import { ULID_REGEX } from './constants'

export function makeEnvelopeSchemas(
  identity: IdentitySchemas,
  limits: CommsLimits = DEFAULT_COMMS_LIMITS,
) {
  const Ulid = z.string().regex(ULID_REGEX)
  const IsoDateTime = z.iso.datetime({ offset: true })

  const SystemMeta = z.object({
    id: Ulid,
    ts: IsoDateTime,
    sender: identity.UserId,
    session: identity.SessionId,
    room: identity.RoomId,
  })

  const BoundedMeta = z
    .record(z.string(), z.unknown())
    .refine((m) => JSON.stringify(m).length <= limits.metaByteLimit, {
      message: `meta exceeds ${limits.metaByteLimit} bytes`,
    })

  const envelopeBase = <T extends z.ZodType>(payload: T) =>
    z.object({
      type: z.string().min(limits.payloadTypeMinLength),
      payload,
      reply_to: Ulid.optional().meta({
        description:
          'Optional. ULID of the message this is replying to, for threading.',
      }),
      client_msg_id: z
        .string()
        .min(limits.clientMsgIdMinLength)
        .max(limits.clientMsgIdMaxLength)
        .optional()
        .meta({
          description: `Optional. Caller-provided idempotency key (length ${limits.clientMsgIdMinLength}-${limits.clientMsgIdMaxLength}). The server dedupes retries with the same id within a session.`,
        }),
      meta: BoundedMeta.optional().meta({
        description: `Optional. Free-form metadata, capped at ${limits.metaByteLimit} bytes when JSON-serialized.`,
      }),
    })

  const receivedBase = <T extends z.ZodType>(payload: T) =>
    z.object({
      ...envelopeBase(payload).shape,
      ...SystemMeta.shape,
      delivered_at: IsoDateTime,
    })

  return {
    Ulid,
    IsoDateTime,
    SystemMeta,
    BoundedMeta,
    envelopeBase,
    receivedBase,
  }
}

export type EnvelopeSchemas = ReturnType<typeof makeEnvelopeSchemas>
export type Ulid = z.infer<EnvelopeSchemas['Ulid']>
export type IsoDateTime = z.infer<EnvelopeSchemas['IsoDateTime']>
export type SystemMeta = z.infer<EnvelopeSchemas['SystemMeta']>
export type BoundedMeta = z.infer<EnvelopeSchemas['BoundedMeta']>

export interface EnvelopeShape {
  type: string
  payload: unknown
  reply_to?: Ulid
  client_msg_id?: string
  meta?: BoundedMeta
}

export interface ReceivedShape extends EnvelopeShape, SystemMeta {
  delivered_at: IsoDateTime
}
