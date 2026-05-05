export interface IdentityLimits {
  readonly idMinLength: number
  readonly idMaxLength: number
}

export const DEFAULT_IDENTITY_LIMITS: IdentityLimits = Object.freeze({
  idMinLength: 1,
  idMaxLength: 128,
})
