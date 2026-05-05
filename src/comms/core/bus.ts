import type { RoomId } from '../../shared/identity'
import type { SessionContext, WireMessage } from './types'

export interface RecentQuery {
  readonly since?: string
  readonly limit: number
  readonly typeFilter?: readonly string[]
}

export interface MessageBus {
  attach(session: SessionContext): void
  detach(session: SessionContext): void
  publish(room: RoomId, message: WireMessage): number
  recentForSession(
    session: SessionContext,
    query: RecentQuery,
  ): readonly WireMessage[]
}
