import { z } from 'zod'
import { DEFAULT_IDENTITY_LIMITS, type IdentityLimits } from './limits'

export function makeIdentitySchemas(
  limits: IdentityLimits = DEFAULT_IDENTITY_LIMITS,
) {
  const idString = z.string().min(limits.idMinLength).max(limits.idMaxLength)
  const UserId = idString.brand<'UserId'>()
  const SessionId = idString.brand<'SessionId'>()
  const RoomId = idString.brand<'RoomId'>()
  const meta = z.record(z.string(), z.unknown()).optional()

  return {
    UserId,
    SessionId,
    RoomId,
    User: z.object({ id: UserId, meta }),
    Room: z.object({ id: RoomId, name: z.string().optional(), meta }),
    Membership: z.object({ user: UserId, room: RoomId }),
    Session: z.object({
      id: SessionId,
      user: UserId,
      rooms: z.array(RoomId),
      meta,
    }),
  }
}

export type IdentitySchemas = ReturnType<typeof makeIdentitySchemas>
export type UserId = z.infer<IdentitySchemas['UserId']>
export type SessionId = z.infer<IdentitySchemas['SessionId']>
export type RoomId = z.infer<IdentitySchemas['RoomId']>
export type User = z.infer<IdentitySchemas['User']>
export type Room = z.infer<IdentitySchemas['Room']>
export type Membership = z.infer<IdentitySchemas['Membership']>
export type Session = z.infer<IdentitySchemas['Session']>

export function brand<T>(value: string): T {
  return value as unknown as T
}
