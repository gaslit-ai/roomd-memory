import { z } from 'zod'
import { DEFAULT_COMMS_LIMITS, type CommsLimits } from '../limits'
import type { EnvelopeSchemas } from './envelope'

export function makeToolSchemas(
  envelope: EnvelopeSchemas,
  limits: CommsLimits = DEFAULT_COMMS_LIMITS,
) {
  const SendOutput = z.object({
    id: envelope.Ulid,
    ts: envelope.IsoDateTime,
    delivered_to: z.number().int().nonnegative().meta({
      description: 'Number of recipients the message was delivered to.',
    }),
  })

  const RecvInput = z.object({
    since: envelope.Ulid.optional().meta({
      description:
        'Optional. Return only messages with id strictly greater than this ULID.',
    }),
    limit: z
      .number()
      .int()
      .min(limits.recvLimitMin)
      .max(limits.recvLimitMax)
      .optional()
      .meta({
        description: `Optional. Max messages to return (${limits.recvLimitMin}-${limits.recvLimitMax}). Defaults to ${limits.recvLimitDefault} when omitted.`,
      }),
    type_filter: z
      .array(z.string().min(limits.typeFilterEntryMinLength))
      .optional()
      .meta({
        description:
          'Optional. If set, return only messages whose type is in this list.',
      }),
  })

  const ReceivedMessage = envelope.receivedBase(z.unknown()).meta({
    description:
      'A received message. Server-stamped fields (id, ts, sender, session, room, delivered_at) are present on every message; payload shape varies by type.',
  })

  const RecvOutput = z.object({
    messages: z.array(ReceivedMessage),
  })

  return { SendOutput, RecvInput, RecvOutput, ReceivedMessage }
}

export type ToolSchemas = ReturnType<typeof makeToolSchemas>
export type SendOutput = z.infer<ToolSchemas['SendOutput']>
export type RecvInput = z.infer<ToolSchemas['RecvInput']>
export type RecvOutput = z.infer<ToolSchemas['RecvOutput']>
