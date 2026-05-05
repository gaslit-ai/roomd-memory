import {
  makeIdentitySchemas,
  type RoomId,
  type SessionId,
  type UserId,
} from '../shared/identity.js'

const defaultIdentity = makeIdentitySchemas()

export const brandUserId = (value: string): UserId =>
  defaultIdentity.UserId.parse(value)

export const brandSessionId = (value: string): SessionId =>
  defaultIdentity.SessionId.parse(value)

export const brandRoomId = (value: string): RoomId =>
  defaultIdentity.RoomId.parse(value)
