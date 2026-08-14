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
import { CastDevice, DeviceNotFoundError, Ipv4, Port } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import {
  Description as DlnaDescription,
  Discovery as Ssdp,
  Ssdp as DlnaSsdp
} from "@castcli/dlna"
import * as State from "../State.ts"

const CAST_SERVICE = "_googlecast._tcp.local"

export type Target = Data.TaggedEnum<{
  readonly Cast: { readonly device: CastDevice }
  readonly Dlna: { readonly renderer: DlnaDescription.Renderer; readonly location: string }
}>

export const Target = Data.taggedEnum<Target>()

export const describe: (target: Target) => string = Match.type<Target>().pipe(
  Match.tag("Cast", ({ device }) => `${device.name} — Cast at ${device.ip}:${device.port}`),
  Match.tag("Dlna", ({ renderer }) => `${renderer.friendlyName} — DLNA`),
  Match.exhaustive
)

/**
 * mDNS unicast replies get dropped often enough on a congested network that an
 * explicit `--ip` is worth having: it skips discovery entirely.
 */
export const castAt = (address: Ipv4, devicePort: number): CastDevice =>
  new CastDevice({ name: address, ip: address, port: Port.make(devicePort) })

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
 * Both sweeps run at once because they are independent waits on different
 * sockets, and running them one after the other would double the time a person
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
        )
      ],
      { concurrency: 2 }
    ),
    ([cast, upnp]) => ({ cast, upnp })
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
 * Sweep both networks and pick something, ignoring whatever was remembered.
 *
 * Cast first when both answer to the name. It is the protocol this tool knows
 * best and the one whose behaviour has been watched end to end on a real
 * television; DLNA is the fallback, not the preference.
 */
export const search = Effect.fn("target.search")(function*(options: {
  readonly name: Option.Option<string>
  readonly timeout: Duration.Duration
}) {
  const client = yield* HttpClient.HttpClient
  yield* Console.log("scanning…")

  const found = yield* discover(options.timeout)
  const matches = matcher(options.name)

  const cast = Array.findFirst(found.cast, (candidate) => matches(candidate.name))

  return yield* Option.match(cast, {
    onSome: (device) => Effect.succeed(Target.Cast({ device })),
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
                    ...found.cast.map((device) => device.name),
                    ...described.map((one) => one.renderer.friendlyName)
                  ]
                })
              )
          }
        ))
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
  options: { readonly name: Option.Option<string>; readonly timeout: Duration.Duration }
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
 * Find something to act on.
 *
 * An explicit address is obeyed exactly and is always Cast — nothing else
 * listens on a bare address without a description to fetch first. Otherwise the
 * name decides, and both networks are searched at once.
 *
 * With no name at all the device from the last session is tried first, because
 * a four second sweep before every pause is most of what those commands cost.
 * What "last session" means differs by protocol, and deliberately: a Cast
 * address goes straight back to the device, while a remembered renderer is a
 * name that still has to be turned into a URL by a sweep. See `State.LastTarget`
 * for why the URL itself is not the thing kept.
 */
export const resolve = Effect.fn("target.resolve")(function*(options: {
  readonly ip: Option.Option<Ipv4>
  readonly name: Option.Option<string>
  readonly devicePort: number
  readonly timeout: Duration.Duration
}) {
  // An explicit name is an instruction, not a preference, so it overrules the
  // memory rather than being filtered by it.
  const remembered = Option.isSome(options.name)
    ? Option.none<State.LastTarget>()
    : yield* State.rememberedTarget

  return yield* Option.match(options.ip, {
    onSome: (address) =>
      Effect.succeed(Target.Cast({ device: castAt(address, options.devicePort) })),
    onNone: () =>
      Option.match(remembered, {
        onNone: () => search(options),
        onSome: Match.type<State.LastTarget>().pipe(
          Match.tag("Cast", ({ ip }) =>
            Effect.succeed(Target.Cast({ device: castAt(ip, options.devicePort) }))),
          Match.tag("Dlna", ({ friendlyName }) => rememberedRenderer(friendlyName, options)),
          Match.exhaustive
        )
      })
  })
})
