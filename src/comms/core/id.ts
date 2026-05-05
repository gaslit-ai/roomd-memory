import {
  CROCKFORD_BASE32,
  ULID_RANDOM_BYTES,
  ULID_TIMESTAMP_LENGTH,
} from '../schemas/constants'
import type { Ulid } from '../schemas/envelope'

export interface IdGenerator {
  next(): Ulid
}

export interface IdGeneratorOptions {
  readonly random?: () => Uint8Array
  readonly now?: () => number
}

export function createUlidGenerator(
  options: IdGeneratorOptions = {},
): IdGenerator {
  const random = options.random ?? defaultRandom
  const now = options.now ?? Date.now
  let lastTime = 0
  let lastRand: Uint8Array = new Uint8Array(ULID_RANDOM_BYTES)

  return {
    next(): Ulid {
      const t = now()
      let randBytes: Uint8Array
      if (t === lastTime) {
        randBytes = incrementBytes(lastRand)
      } else {
        randBytes = random()
        if (randBytes.length !== ULID_RANDOM_BYTES) {
          throw new Error(
            `random() must return exactly ${ULID_RANDOM_BYTES} bytes`,
          )
        }
        lastTime = t
      }
      lastRand = randBytes
      return (encodeTimestamp(t) + encodeRandom(randBytes)) as Ulid
    },
  }
}

function defaultRandom(): Uint8Array {
  const bytes = new Uint8Array(ULID_RANDOM_BYTES)
  crypto.getRandomValues(bytes)
  return bytes
}

function encodeTimestamp(ms: number): string {
  let n = ms
  let chars = ''
  for (let i = ULID_TIMESTAMP_LENGTH - 1; i >= 0; i--) {
    chars = CROCKFORD_BASE32.charAt(n % 32) + chars
    n = Math.floor(n / 32)
  }
  return chars
}

function encodeRandom(bytes: Uint8Array): string {
  let chars = ''
  let buffer = 0
  let bits = 0
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | (bytes[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      chars += CROCKFORD_BASE32.charAt((buffer >>> bits) & 0x1f)
    }
  }
  if (bits > 0) {
    chars += CROCKFORD_BASE32.charAt((buffer << (5 - bits)) & 0x1f)
  }
  return chars
}

function incrementBytes(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input)
  for (let i = out.length - 1; i >= 0; i--) {
    const current = out[i] ?? 0
    if (current < 0xff) {
      out[i] = current + 1
      return out
    }
    out[i] = 0
  }
  throw new Error('ULID monotonic counter overflow within millisecond')
}
