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
export const parseAirPlayFeatures = (featuresHex: string): bigint | undefined => {
  const parts = featuresHex.split(",")
  const word = (hex: string): bigint => BigInt(hex.startsWith("0x") ? hex : `0x${hex}`)
  try {
    const lo = word(parts[0] ?? "0")
    const hi = (parts[1] ?? "").length > 0 ? word(parts[1] ?? "0") : 0n
    return (hi << 32n) | lo
  } catch {
    return undefined
  }
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
