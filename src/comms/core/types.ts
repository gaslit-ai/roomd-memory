import type { RoomId, SessionId, UserId } from '../../shared/identity'
import type { ReceivedShape } from '../schemas/envelope'

export type WireMessage = ReceivedShape

export interface SessionContext {
  readonly id: SessionId
  readonly user: UserId
  readonly rooms: readonly RoomId[]
  emit(message: WireMessage): void
  close(reason?: string): void
}
