// An AirPlay device on the local network.
//
// Discovered via mDNS _airplay._tcp on port 7000. The TXT record's features
// bitmask tells us whether it speaks video (bit 0 || bit 49), but pairing and
// session details live in the protocol layer, not here.

import { Schema } from "effect"
import { Ipv4, Port } from "./Brands.ts"

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
   * True if bit 26 (HasUnifiedAdvertiserInfo) or bit 51 (SupportsUnifiedPairSetupAndMFi / Authentication_8) is set.
   * When true, the sender must POST /auth-setup with a Curve25519 public key before pair-verify or play.
   */
  get requiresMFiAuth(): boolean {
    return this.features !== undefined
      ? (this.features & (1n << 26n)) !== 0n || (this.features & (1n << 51n)) !== 0n
      : false
  }
}
