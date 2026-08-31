// Finding something to play to, whichever protocol it speaks.
//
// This lives apart from any one command because `play` and every control
// command need the same answer to the same question, and a person naming their
// television does not know or care which protocol it speaks. Answering that
// question twice — once for starting a film and once for pausing it — is how a
// tool ends up able to start something it cannot then stop.
//
// A tagged union rather than an interface with two implementations. The two
// protocols agree on almost nothing — one launches an application over a
// persistent TLS connection, the other posts SOAP at a URL and keeps no
// connection at all — and the single thing they share, that the *device*
// fetches the media from us, is a property of the media server rather than of
// any object. With two protocols an interface would be a shape traced around
// the first one; a union makes every site that acts on a target handle both,
// and `Match.exhaustive` says so at compile time.

import { Array, Console, Data, Duration, Effect, Match, Option } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AirPlayDevice, CastDevice, DeviceNotFoundError, Ipv4, Port } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import {
  Description as DlnaDescription,
  Discovery as Ssdp,
  Ssdp as DlnaSsdp
} from "@castcli/dlna"
import * as State from "../State.ts"

export type Protocol = "cast" | "airplay" | "dlna"

const CAST_SERVICE = "_googlecast._tcp.local"
const AIRPLAY_SERVICE = "_airplay._tcp.local"

export type Target = Data.TaggedEnum<{
  readonly Cast: { readonly device: CastDevice }
  readonly Dlna: { readonly renderer: DlnaDescription.Renderer; readonly location: string }
  readonly AirPlay: { readonly device: AirPlayDevice }
}>

export const Target = Data.taggedEnum<Target>()

export const describe: (target: Target) => string = Match.type<Target>().pipe(
  Match.tag("Cast", ({ device }) => `${device.name} — Cast at ${device.ip}:${device.port}`),
  Match.tag("Dlna", ({ renderer }) => `${renderer.friendlyName} — DLNA`),
  Match.tag("AirPlay", ({ device }) => `${device.name} — AirPlay at ${device.ip}:${device.port}`),
  Match.exhaustive
)

/**
 * mDNS unicast replies get dropped often enough on a congested network that an
 * explicit `--ip` is worth having: it skips discovery entirely.
 */
export const castAt = (address: Ipv4, devicePort: number): CastDevice =>
  new CastDevice({ name: address, ip: address, port: Port.make(devicePort) })

export const airPlayAt = (address: Ipv4, devicePort: number): AirPlayDevice =>
  new AirPlayDevice({ name: address, ip: address, port: Port.make(devicePort) })

/**
 * Fetch a renderer's description and read it.
 *
 * An SSDP advertisement is only a pointer: it says a device exists and where
 * its description lives, and nothing about whether it can play video. A media
 * *server* on a NAS answers the same search, so the description is what tells a
 * television apart from a filing cabinet — and it is also the only place the
 * control URLs live, which is what every command below ultimately posts to.
 *
 * A device that fails to answer is dropped rather than reported: it was found
 * by a broadcast we sent to the whole network, and something on it being
 * unreachable is not an error in what the person asked for.
 */
export const describeRenderer = (client: HttpClient.HttpClient, location: string) =>
  client.get(location).pipe(
    Effect.flatMap((response) => response.text),
    Effect.map((xml) => DlnaDescription.parseRenderer(xml, location)),
    Effect.orElseSucceed(() => Option.none<DlnaDescription.Renderer>())
  )

/**
 * Everything on the network we could play to, still undescribed.
 *
 * All three sweeps run at once because they are independent waits on different
 * sockets, and running them sequentially would triple the time a person
 * spends looking at "scanning…" for no reason.
 */
export const discover = (timeout: Duration.Duration) =>
  Effect.map(
    Effect.all(
      [
        Effect.orElseSucceed(Mdns.discoverWithRetry(CAST_SERVICE, timeout), () => []),
        Effect.orElseSucceed(
          Effect.scoped(Ssdp.search(DlnaSsdp.MEDIA_RENDERER, timeout)),
          () => []
        ),
        Effect.orElseSucceed(Mdns.discoverAirPlayWithRetry(AIRPLAY_SERVICE, timeout), () => [])
      ],
      { concurrency: 3 }
    ),
    ([cast, upnp, airplay]) => ({ cast, upnp, airplay })
  )

/** Every renderer that answered, with its description read. */
const renderersAmong = (
  client: HttpClient.HttpClient,
  found: ReadonlyArray<{ readonly location: string }>
) =>
  Effect.map(
    Effect.forEach(
      found,
      (device) =>
        Effect.map(describeRenderer(client, device.location), (described) =>
          Option.map(described, (renderer) => ({ renderer, location: device.location }))),
      { concurrency: 4 }
    ),
    Array.getSomes
  )

const matcher = (name: Option.Option<string>) => (candidate: string): boolean =>
  Option.match(name, {
    onNone: () => true,
    onSome: (wanted) => candidate.toLowerCase().includes(wanted.toLowerCase())
  })

/**
 * Sweep all three networks and pick something, ignoring whatever was remembered.
 *
 * When no protocol is specified, Cast is preferred when multiple devices answer
 * to the name, as it is the protocol this tool knows best. AirPlay second,
 * DLNA third. When a protocol is given, only that protocol is searched.
 */
export const search = Effect.fn("target.search")(function*(options: {
  readonly name: Option.Option<string>
  readonly timeout: Duration.Duration
  readonly protocol: Option.Option<Protocol>
}) {
  const client = yield* HttpClient.HttpClient
  yield* Console.log("scanning…")

  const found = yield* discover(options.timeout)
  const matches = matcher(options.name)

  return yield* Option.match(options.protocol, {
    onNone: () =>
      Effect.gen(function*() {
        const cast = Array.findFirst(found.cast, (candidate) => matches(candidate.name))

        return yield* Option.match(cast, {
          onSome: (device) => Effect.succeed(Target.Cast({ device })),
          onNone: () =>
            Effect.gen(function*() {
              const airplay = Array.findFirst(
                found.airplay.filter((device) => device.supportsVideo),
                (candidate) => matches(candidate.name)
              )
              return yield* Option.match(airplay, {
                onSome: (device) => Effect.succeed(Target.AirPlay({ device })),
                onNone: () =>
                  Effect.flatMap(renderersAmong(client, found.upnp), (described) =>
                    Option.match(
                      Array.findFirst(described, (candidate) => matches(candidate.renderer.friendlyName)),
                      {
                        onSome: (candidate) => Effect.succeed(Target.Dlna(candidate)),
                        onNone: () =>
                          Effect.fail(
                            new DeviceNotFoundError({
                              query: Option.getOrElse(options.name, () => "(first available)"),
                              found: [
                                ...found.cast.map((device) => `${device.name} (Cast)`),
                                ...found.airplay.map((device) => `${device.name} (AirPlay)`),
                                ...described.map((one) => `${one.renderer.friendlyName} (DLNA)`)
                              ]
                            })
                          )
                      }
                    ))
              })
            })
        })
      }),
    onSome: (proto) =>
      Effect.gen(function*() {
        return yield* (proto === "cast"
          ? Effect.gen(function*() {
              const cast = Array.findFirst(found.cast, (candidate) => matches(candidate.name))
              return yield* Option.match(cast, {
                onSome: (device) => Effect.succeed(Target.Cast({ device })),
                onNone: () =>
                  Effect.fail(
                    new DeviceNotFoundError({
                      query: Option.getOrElse(options.name, () => "(first available)"),
                      found: found.cast.map((device) => `${device.name} (Cast)`)
                    })
                  )
              })
            })
          : proto === "airplay"
            ? Effect.gen(function*() {
                const airplay = Array.findFirst(found.airplay, (candidate) => matches(candidate.name))
                return yield* Option.match(airplay, {
                  onSome: (device) => Effect.succeed(Target.AirPlay({ device })),
                  onNone: () =>
                    Effect.fail(
                      new DeviceNotFoundError({
                        query: Option.getOrElse(options.name, () => "(first available)"),
                        found: found.airplay.map((device) => `${device.name} (AirPlay)`)
                      })
                    )
                })
              })
            : Effect.flatMap(renderersAmong(client, found.upnp), (described) =>
                Option.match(
                  Array.findFirst(described, (candidate) => matches(candidate.renderer.friendlyName)),
                  {
                    onSome: (candidate) => Effect.succeed(Target.Dlna(candidate)),
                    onNone: () =>
                      Effect.fail(
                        new DeviceNotFoundError({
                          query: Option.getOrElse(options.name, () => "(first available)"),
                          found: described.map((one) => `${one.renderer.friendlyName} (DLNA)`)
                        })
                      )
                  }
                )))
      })
  })
})

/**
 * Turn a remembered renderer *name* back into somewhere to post SOAP.
 *
 * Only SSDP is swept, because the memory already says which protocol answered
 * last and searching mDNS as well would let a Cast device that happens to share
 * the name steal a command aimed at the television beside it. If the renderer
 * is not there any more, the ordinary search runs — a memory that has gone
 * stale must cost time at worst, never an error of its own.
 */
const rememberedRenderer = (
  friendlyName: string,
  options: {
    readonly name: Option.Option<string>
    readonly timeout: Duration.Duration
    readonly protocol: Option.Option<Protocol>
  }
) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    yield* Console.log("scanning…")

    const found = yield* Effect.orElseSucceed(
      Effect.scoped(Ssdp.search(DlnaSsdp.MEDIA_RENDERER, options.timeout)),
      () => []
    )
    const described = yield* renderersAmong(client, found)

    return yield* Option.match(
      Array.findFirst(described, (candidate) => candidate.renderer.friendlyName === friendlyName),
      {
        onSome: (candidate) => Effect.succeed(Target.Dlna(candidate)),
        onNone: () => search(options)
      }
    )
  })

/**
 * Turn a remembered AirPlay address back into a device.
 *
 * Try the address directly first, then fall back to discovery if unreachable.
 */
const rememberedAirPlay = (
  ip: Ipv4,
  options: { readonly name: Option.Option<string>; readonly timeout: Duration.Duration; readonly devicePort: number }
) =>
  Effect.succeed(Target.AirPlay({ device: airPlayAt(ip, options.devicePort) }))

/**
 * Find something to act on.
 *
 * An explicit address with no protocol tries both Cast and AirPlay (via probe).
 * An explicit address WITH a protocol uses that protocol's port directly.
 * Otherwise the name decides, and all three networks are searched at once.
 *
 * With no name at all the device from the last session is tried first, because
 * a four second sweep before every pause is most of what those commands cost.
 * What "last session" means differs by protocol, and deliberately: Cast and
 * AirPlay addresses go straight back to the device, while a remembered renderer
 * is a name that still has to be turned into a URL by a sweep. See
 * `State.LastTarget` for why the URL itself is not the thing kept.
 */
export const resolve = Effect.fn("target.resolve")(function*(options: {
  readonly ip: Option.Option<Ipv4>
  readonly name: Option.Option<string>
  readonly devicePort: number
  readonly airplayPort: number
  readonly timeout: Duration.Duration
  readonly protocol: Option.Option<Protocol>
}) {
  // An explicit name is an instruction, not a preference, so it overrules the
  // memory rather than being filtered by it.
  const remembered = Option.isSome(options.name)
    ? Option.none<State.LastTarget>()
    : yield* State.rememberedTarget

  return yield* Option.match(options.ip, {
    onSome: (address) =>
      Option.match(options.protocol, {
        onNone: () =>
          Effect.succeed(Target.Cast({ device: castAt(address, options.devicePort) })),
        onSome: (proto) =>
          proto === "cast"
            ? Effect.succeed(Target.Cast({ device: castAt(address, options.devicePort) }))
            : proto === "airplay"
              ? Effect.gen(function*() {
                  const client = yield* HttpClient.HttpClient
                  
                  const serverInfoResponse = yield* client
                    .get(`http://${address}:${options.airplayPort}/server-info`)
                    .pipe(
                      Effect.flatMap((r) => r.text),
                      Effect.orElseSucceed(() => "")
                    )

                  const serverInfoHasContent = serverInfoResponse.length > 0

                  const features = yield* (serverInfoHasContent
                    ? Effect.succeed((() => {
                        const featuresMatch = serverInfoResponse.match(
                          /<key>features<\/key>\s*<integer>(0x[0-9a-fA-F]+)<\/integer>/
                        )
                        return featuresMatch?.[1] !== undefined ? BigInt(featuresMatch[1]) : undefined
                      })())
                    : Effect.gen(function*() {
                        const infoResponse = yield* client
                          .get(`http://${address}:${options.airplayPort}/info`)
                          .pipe(
                            Effect.flatMap((r) => r.arrayBuffer),
                            Effect.map((buf) => new Uint8Array(buf)),
                            Effect.orElseSucceed(() => new Uint8Array(0))
                          )

                        const hasInfo = infoResponse.length > 0
                        return hasInfo
                          ? (() => {
                            const text = new TextDecoder().decode(infoResponse)
                            const featuresMatch = text.match(/<key>features<\/key>\s*<integer>(\d+)<\/integer>/)
                            return featuresMatch?.[1] !== undefined ? BigInt(featuresMatch[1]) : undefined
                          })()
                          : undefined
                      }))

                  return Target.AirPlay({
                    device: new AirPlayDevice({
                      name: address,
                      ip: address,
                      port: Port.make(options.airplayPort),
                      features
                    })
                  })
                })
              : Effect.fail(
                  new DeviceNotFoundError({
                    query: `${address} (DLNA)`,
                    found: []
                  })
                )
      }),
    onNone: () =>
      Option.match(remembered, {
        onNone: () => search(options),
        onSome: Match.type<State.LastTarget>().pipe(
          Match.tag("Cast", ({ ip }) =>
            Effect.succeed(Target.Cast({ device: castAt(ip, options.devicePort) }))),
          Match.tag("Dlna", ({ friendlyName }) => rememberedRenderer(friendlyName, options)),
          Match.tag("AirPlay", ({ ip }) => rememberedAirPlay(ip, { ...options, devicePort: options.airplayPort })),
          Match.exhaustive
        )
      })
  })
})
