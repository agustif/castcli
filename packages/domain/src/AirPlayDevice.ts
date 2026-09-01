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

const MAC_MODEL = /^Mac\d+,\d+$/

/** True for macOS AirPlay Receiver model strings (`Mac15,9`). */
export const isMacAirPlayReceiver = (model: string | undefined): boolean =>
  model !== undefined && MAC_MODEL.test(model)

/**
 * Apple TV authorizes HAP pair-setup on the socket that called pair-pin-start.
 * A Mac receiver does not: pair-pin-start is 403 (ACL / not implemented), and
 * authorization is the system “Allow AirPlay” dialog plus TXT `act`.
 */
export const wantsPairPinStart = (model: string | undefined): boolean =>
  !isMacAirPlayReceiver(model)

/** Human label for TXT `act` when we recognize it. */
export const describeAirPlayAccessControl = (
  act: string | undefined
): string | undefined =>
  act === "2" ? "Current User (Apple Account devices only)"
  : act === "0" ? "unrestricted"
  : act

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
  deviceId: Schema.optional(Schema.String),
  /** TXT `act` — Access Control Type. `2` is Current User (Apple Account). */
  act: Schema.optional(Schema.String),
  /** TXT `acl` — Access Control Level. `1` disables pairing for non-Home devices. */
  acl: Schema.optional(Schema.String)
}) {
  get address(): string {
    return `${this.ip}:${this.port}`
  }

  /**
   * macOS AirPlay Receiver (`Mac15,9`, …). It is not an Apple TV: it has no
   * on-screen HAP PIN overlay, and `POST /pair-pin-start` is 403.
   */
  get isMacReceiver(): boolean {
    return isMacAirPlayReceiver(this.model)
  }

  /**
   * Whether the ATV `POST /pair-pin-start` prelude should run.
   * macOS receivers reject that path; sending it and then pair-setup on the
   * same socket is the bug this field exists to stop.
   */
  get wantsPairPinStart(): boolean {
    return !isMacAirPlayReceiver(this.model)
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
