// A UPnP device description, read for the two things a control point needs:
// what the device is called, and where to send control messages.
//
// SSDP hands us a `LOCATION` header and nothing else. Everything needed to
// actually drive the television — the AVTransport control URL for play, pause
// and seek, the RenderingControl one for volume — lives in the XML at the far
// end of that URL, and is written there *relative* to it. Using a control URL
// as it appears in the document is the single most common DLNA integration
// bug: `/AVTransport/control` is not a URL anything can post to, and the
// failure looks like the television ignoring us rather than like a mistake of
// ours, so every control URL here is resolved before it leaves this module.

import { Array, Option } from "effect"
import { XMLParser } from "fast-xml-parser"

export interface Service {
  readonly serviceType: string
  /** Absolute, resolved against the description's own URL. */
  readonly controlUrl: string
}

export interface Renderer {
  readonly friendlyName: string
  readonly manufacturer: Option.Option<string>
  readonly modelName: Option.Option<string>
  readonly avTransport: Service
  readonly renderingControl: Option.Option<Service>
}

const parser = new XMLParser({
  // Attributes are kept rather than dropped, because descriptions carry real
  // information in them — `<dlna:X_DLNADOC>`, icon dimensions, Samsung's `sec:`
  // extensions — and a parser configured to discard them makes all of that
  // unavailable to anything built on this later. The cost is that an element
  // carrying an attribute parses as an object with its text under `#text`
  // rather than as a plain string, which `text` below handles.
  ignoreAttributes: false,
  // Whether a device writes `<serviceType>` or `<u:serviceType>` is its own
  // business, and vendors differ. Stripping the prefix means we look up the
  // element we care about instead of enumerating the prefixes anyone might
  // have chosen.
  removeNSPrefix: true,
  // Text stays text. Left on, the parser runs values through a number guess,
  // which turns the model name `55` into the number 55, the serial number
  // `0000` into 0, and the version `1.0` into 1 — all of which then render
  // back as something the device never said.
  parseTagValue: false,
  // The parser collapses a lone child into an object and only builds an array
  // when there are two or more, so a device with one service and a device with
  // three would otherwise need different code paths. Forcing these two names
  // to always be arrays gives one shape to read.
  isArray: (name) => name === "service" || name === "device"
})

/**
 * Parsing is lifted rather than wrapped in a `try`: `fast-xml-parser` throws on
 * a malformed document, and a device serving truncated XML is a thing that
 * happens, not a defect in this program.
 */
const parseXml = Option.liftThrowable((xml: string): unknown => parser.parse(xml))

/**
 * `new URL` throws on a base it cannot understand, which is what an SSDP
 * `LOCATION` from a misbehaving device looks like. Lifting it makes that
 * device simply not appear in the list.
 */
const resolveUrl = Option.liftThrowable((relative: string, base: string): string =>
  new URL(relative, base).toString())

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const field = (value: unknown, key: string): Option.Option<unknown> =>
  isRecord(value) ? Option.fromNullishOr(value[key]) : Option.none()

const list = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

/**
 * The text of an element, in either of the two shapes the parser produces: a
 * bare string when the element has no attributes, and `#text` when it has.
 *
 * An element present but empty is absence, not a value: `<modelName/>` names
 * no model, and letting `""` through means a device list with a blank row in
 * it.
 */
const text = (value: unknown): Option.Option<string> =>
  Option.firstSomeOf([
    typeof value === "string" ? Option.some(value) : Option.none<string>(),
    field(value, "#text").pipe(
      Option.flatMap((inner) => typeof inner === "string" ? Option.some(inner) : Option.none())
    )
  ]).pipe(
    Option.flatMap((found) => found.trim().length === 0 ? Option.none() : Option.some(found.trim()))
  )

/** The text of a named child element. */
const child = (node: unknown, key: string): Option.Option<string> =>
  field(node, key).pipe(Option.flatMap(text))

/** The `child` elements inside a `wrapper` element, e.g. `serviceList/service`. */
const under = (node: unknown, wrapper: string, name: string): ReadonlyArray<unknown> =>
  field(node, wrapper).pipe(
    Option.flatMap((wrapped) => field(wrapped, name)),
    Option.map(list),
    Option.getOrElse((): ReadonlyArray<unknown> => [])
  )

/**
 * The service name out of `urn:schemas-upnp-org:service:AVTransport:1`.
 *
 * The trailing version is the device's own choice — `:1`, `:2` and `:3` are all
 * in the field — and a set advertising AVTransport:2 answers the same actions
 * we send, because later versions add actions rather than change existing ones.
 * Matching the whole URN would silently skip those devices, so the version is
 * required to be present and then ignored.
 */
const SERVICE_TYPE = /^urn:[^:]+:service:([^:]+):\d+$/

const serviceName = (serviceType: string): Option.Option<string> =>
  Option.fromNullishOr(SERVICE_TYPE.exec(serviceType)?.[1])

/**
 * A service, with its control URL made absolute. A service whose `controlURL`
 * is missing or unresolvable is dropped rather than kept with a broken URL,
 * so nothing downstream has to wonder whether the string it holds is postable.
 */
const toService = (node: unknown, base: string): Option.Option<Service> =>
  Option.all({
    serviceType: child(node, "serviceType"),
    controlUrl: child(node, "controlURL").pipe(
      Option.flatMap((relative) => resolveUrl(relative, base))
    )
  })

const findService = (device: unknown, base: string, name: string): Option.Option<Service> =>
  Array.findFirst(
    Array.getSomes(under(device, "serviceList", "service").map((node) => toService(node, base))),
    (service) =>
      serviceName(service.serviceType).pipe(
        Option.match({ onNone: () => false, onSome: (found) => found === name })
      )
  )

/**
 * Every device in the description, the root one first and embedded ones after
 * it, depth first.
 *
 * Devices are allowed to nest, and plenty do: a combined server-and-renderer
 * box advertises a root device that holds neither service and a `deviceList`
 * containing the MediaRenderer that holds both. Looking only at the root finds
 * nothing on exactly the hardware most likely to be on a home network.
 */
const flatten = (device: unknown): ReadonlyArray<unknown> => [
  device,
  ...under(device, "deviceList", "device").flatMap(flatten)
]

/**
 * A renderer, if this device is one.
 *
 * AVTransport is the deciding service, because it is the one that carries
 * `SetAVTransportURI` and `Play`. A device without it is not something we can
 * put a film on — a NAS advertising only ContentDirectory is a media *server*,
 * it answers discovery exactly like a television does, and treating it as a
 * playback target means offering the user a device that will never respond.
 *
 * RenderingControl is optional in the other direction: it only carries volume,
 * and a renderer that omits it (a set with a fixed output level, an amplifier
 * that does its own mixing) is still perfectly playable.
 */
const rendererFrom = (
  device: unknown,
  base: string,
  rootName: Option.Option<string>
): Option.Option<Renderer> =>
  Option.all({
    // The name shown to a person picking a device. An embedded renderer
    // sometimes leaves it off, in which case the root device's name is the one
    // the user already saw during discovery and so the right one to keep.
    friendlyName: child(device, "friendlyName").pipe(Option.orElse(() => rootName)),
    avTransport: findService(device, base, "AVTransport")
  }).pipe(
    Option.map(({ avTransport, friendlyName }) => ({
      friendlyName,
      manufacturer: child(device, "manufacturer"),
      modelName: child(device, "modelName"),
      avTransport,
      renderingControl: findService(device, base, "RenderingControl")
    }))
  )

/**
 * Read a renderer out of its description. `location` is where it was fetched.
 *
 * Relative URLs resolve against `URLBase` when the document declares one and
 * against `location` otherwise. UPnP 1.1 deprecated `URLBase` and modern
 * devices omit it, but 1.0 devices are still shipping and still on networks,
 * and one that puts its control server on a different port from its
 * description server says so only there — ignoring it produces URLs that
 * resolve to the wrong port and time out.
 */
export const parseRenderer = (xml: string, location: string): Option.Option<Renderer> =>
  parseXml(xml).pipe(
    Option.flatMap((document) => field(document, "root")),
    Option.flatMap((root) => {
      const base = child(root, "URLBase").pipe(Option.getOrElse(() => location))
      const devices = list(Option.getOrElse(field(root, "device"), () => [])).flatMap(flatten)
      const rootName = Array.head(devices).pipe(Option.flatMap((device) =>
        child(device, "friendlyName")
      ))
      return Option.firstSomeOf(devices.map((device) => rendererFrom(device, base, rootName)))
    })
  )
