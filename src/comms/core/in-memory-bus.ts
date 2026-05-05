import type { RoomId } from '../../shared/identity'
import { DEFAULT_COMMS_LIMITS, type CommsLimits } from '../limits'
import type { MessageBus, RecentQuery } from './bus'
import type { SessionContext, WireMessage } from './types'

export class InMemoryBus implements MessageBus {
  private readonly subs = new Map<RoomId, Set<SessionContext>>()
  private readonly recent = new Map<RoomId, WireMessage[]>()

  constructor(private readonly limits: CommsLimits = DEFAULT_COMMS_LIMITS) {}

  attach(session: SessionContext): void {
    for (const room of session.rooms) {
      let set = this.subs.get(room)
      if (!set) {
        set = new Set()
        this.subs.set(room, set)
      }
      set.add(session)
    }
  }

  detach(session: SessionContext): void {
    for (const room of session.rooms) {
      const set = this.subs.get(room)
      if (!set) continue
      set.delete(session)
      if (set.size === 0) this.subs.delete(room)
    }
  }

  publish(room: RoomId, message: WireMessage): number {
    this.appendRecent(room, message)
    const set = this.subs.get(room)
    if (!set) return 0
    let count = 0
    for (const sub of set) {
      sub.emit(message)
      count++
    }
    return count
  }

  recentForSession(
    session: SessionContext,
    query: RecentQuery,
  ): readonly WireMessage[] {
    const out: WireMessage[] = []
    for (const room of session.rooms) {
      const buf = this.recent.get(room)
      if (!buf) continue
      // Per-room buffers are appended in ULID order, so scanning from the
      // tail lets us stop at the `since` boundary and bound work to `limit`.
      let collected = 0
      for (let i = buf.length - 1; i >= 0 && collected < query.limit; i--) {
        const msg = buf[i]!
        if (query.since !== undefined && msg.id <= query.since) break
        if (query.typeFilter && !query.typeFilter.includes(msg.type)) continue
        out.push(msg)
        collected++
      }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return out.slice(0, query.limit)
  }

  private appendRecent(room: RoomId, message: WireMessage): void {
    let buf = this.recent.get(room)
    if (!buf) {
      buf = []
      this.recent.set(room, buf)
    }
    buf.push(message)
    const overflow = buf.length - this.limits.recentBufferPerRoom
    if (overflow > 0) buf.splice(0, overflow)
  }
}
