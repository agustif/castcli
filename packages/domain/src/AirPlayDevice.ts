// An AirPlay device on the local network.
//
// Discovered via mDNS _airplay._tcp on port 7000. The TXT record's features
// bitmask tells us whether it speaks video (bit 0 || bit 49), but pairing and
// session details live in the protocol layer, not here.

import { Schema } from "effect"
import { Ipv4, Port } from "./Brands.ts"

/**
 * TXT `features` is `0xLOWER,0xUPPER` (sometimes a single word).
 * The 64-bit mask is `(UPPER << 32) | LOWER`. Parsing only the first
 * word drops Video V2 (bit 49), which is how a Xiaomi that plays video
 * was listed as audio-only.
 */
const HEX_WORD = /^(0x)?[0-9a-fA-F]+$/i

const parseHexWord = (hex: string): bigint | undefined => {
  const normalized = hex.startsWith("0x") || hex.startsWith("0X") ? hex : `0x${hex}`
  return HEX_WORD.test(hex) ? BigInt(normalized) : undefined
}

export const parseAirPlayFeatures = (featuresHex: string): bigint | undefined => {
  const parts = featuresHex.split(",")
  const lo = parseHexWord(parts[0] ?? "0")
  const hiRaw = parts[1] ?? ""
  const hi = hiRaw.length > 0 ? parseHexWord(hiRaw) : 0n
  return lo === undefined || hi === undefined ? undefined : (hi << 32n) | lo
}


export class AirPlayDevice extends Schema.Class<AirPlayDevice>("AirPlayDevice")({
  name: Schema.String,
  ip: Ipv4,
  port: Port,
  /** Features bitmask from TXT `features` field. */
  features: Schema.optional(Schema.BigInt),
  /** Flags from TXT `flags` field (pairing/PIN requirements). */
  flags: Schema.optional(Schema.Number),
  /** Model string, e.g. `AppleTV11,1`. */
  model: Schema.optional(Schema.String),
  /** Device ID from TXT `deviceid`. */
  deviceId: Schema.optional(Schema.String)
}) {
  get address(): string {
    return `${this.ip}:${this.port}`
  }

  /** Whether this device claims video capability (bit 0 or bit 49). */
  get supportsVideo(): boolean {
    return this.features !== undefined
      ? (this.features & 1n) !== 0n || (this.features & (1n << 49n)) !== 0n
      : false
  }

  /**
   * Whether this device requires MFi auth-setup before play.
   *
   * True if bit 51 (SupportsUnifiedPairSetupAndMFi / Authentication_8) is set.
   * When true, the sender must POST /auth-setup with a Curve25519 public key before pair-verify or play.
   * Bit 26 (HasUnifiedAdvertiserInfo) is NOT MFi auth.
   */
  get requiresMFiAuth(): boolean {
    return this.features !== undefined
      ? (this.features & (1n << 51n)) !== 0n
      : false
  }
}
