import type { RoomId, UserId } from '../../shared/identity'
import type { Dispatcher } from '../core/dispatcher'

export interface AuthenticatedClaims {
  readonly userId: UserId
  readonly rooms: readonly RoomId[]
}

export type Authenticator<TInput> = (
  input: TInput,
) => AuthenticatedClaims | Promise<AuthenticatedClaims>

export interface CommsAdapter {
  start(): Promise<void> | void
  stop(): Promise<void> | void
}

export interface AdapterContext {
  readonly dispatcher: Dispatcher
}
