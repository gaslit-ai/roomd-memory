export interface CommsLimits {
  readonly metaByteLimit: number
  readonly clientMsgIdMinLength: number
  readonly clientMsgIdMaxLength: number
  readonly payloadTypeMinLength: number
  readonly recvLimitMin: number
  readonly recvLimitMax: number
  readonly recvLimitDefault: number
  readonly typeFilterEntryMinLength: number
  readonly recentBufferPerRoom: number
  readonly idempotencyWindowSize: number
}

export const DEFAULT_COMMS_LIMITS: CommsLimits = Object.freeze({
  metaByteLimit: 4096,
  clientMsgIdMinLength: 1,
  clientMsgIdMaxLength: 128,
  payloadTypeMinLength: 1,
  recvLimitMin: 1,
  recvLimitMax: 500,
  recvLimitDefault: 100,
  typeFilterEntryMinLength: 1,
  recentBufferPerRoom: 1000,
  idempotencyWindowSize: 256,
})
