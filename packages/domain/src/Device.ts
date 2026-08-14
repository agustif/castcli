// A Cast device on the local network.
//
// The address is a branded `Ipv4` rather than a bare string, because handing a
// device an address it cannot route back to is precisely the failure this tool
// was written to avoid.

import { Schema } from "effect"
import { Ipv4, Port } from "./Brands.ts"

export class CastDevice extends Schema.Class<CastDevice>("CastDevice")({
  name: Schema.String,
  ip: Ipv4,
  port: Port,
  /** Model string from the mDNS TXT record, e.g. `MiTV-MOEU0`. */
  model: Schema.optional(Schema.String),
  /** What the device says it is currently doing, e.g. `Default Media Receiver`. */
  status: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String)
}) {
  get address(): string {
    return `${this.ip}:${this.port}`
  }
}
