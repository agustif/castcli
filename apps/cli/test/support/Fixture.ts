// Shared scaffolding for the end-to-end tests.
//
// These spawn the built binary at an emulated device and watch what it does.
// Everything here is about making that affordable: the sample film is generated
// once and cached, the binary is the bundle rather than the sources through tsx
// (0.1s to start against 0.7s), and the player is killed with the scope because
// it never exits on its own.

import { Config, Console, Duration, Effect, Option, Schedule } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

/**
 * Refuse to run beside a player left over from an earlier run.
 *
 * A stray `cast play` keeps sweeping for its device, and the mDNS and SSDP
 * answers it draws are enough to make a discovery test look for ninety seconds
 * and find nothing. That has now happened three times, each time presenting as
 * a mysterious timeout in whichever test ran first. Failing immediately with
 * the reason is worth more than the tidiest possible cleanup, because cleanup
 * cannot be guaranteed: a test killed by a timeout — or by someone pressing
 * Ctrl-C — never runs its finalizers at all.
 */
export const noStrayPlayers = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const running = yield* Effect.orElseSucceed(
    // Matched on how node invokes it, not on the bare string: a shell whose own
    // command line mentions `cast.cjs play` — the very `pkill` someone runs to
    // clean up, for instance — would otherwise match itself and report a stray
    // that does not exist.
    spawner.string(ChildProcess.make("pgrep", ["-f", "node .*dist/cast\\.cjs play"])),
    () => ""
  )
  const count = running.split("\n").filter((line) => line.trim().length > 0).length

  return yield* Effect.when(
    Effect.die(
      new Error(
        `${count} stray \`cast play\` process(es) are still running from an earlier run. ` +
          "They keep searching for a device that no longer exists, and their traffic makes " +
          "discovery tests time out. Run: pkill -f 'cast.cjs play'"
      )
    ),
    Effect.succeed(count > 0)
  )
})

const hasBinary = (name: string) =>
  Effect.map(
    Effect.exit(
      Effect.flatMap(
        ChildProcessSpawner.ChildProcessSpawner,
        (spawner) => spawner.string(ChildProcess.make(name, ["-version"]))
      )
    ),
    (exit) => exit._tag === "Success"
  )

/**
 * Insist on the tools these tests need, rather than quietly doing nothing.
 *
 * This used to return a boolean that each test wrapped its whole body in, so a
 * machine without ffmpeg reported *four passing tests in eighty-five
 * milliseconds* — no assertions run, nothing skipped, and `npm run check`
 * green. CI installs ffmpeg today, so it ran; the day that `apt-get` step
 * failed, the only test of the inversion this tool is built around would have
 * become a silent no-op and nothing would have said so.
 *
 * Failing is the right default because the tools are cheap and the alternative
 * is a suite that lies. Someone who genuinely cannot install them can set
 * `CASTCLI_E2E_SKIP=1`, which is deliberately awkward and impossible to do by
 * accident in CI.
 */
export const requireBinaries = (...names: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const skip = yield* Config.string("CASTCLI_E2E_SKIP").pipe(Config.option)

    const missing = yield* Effect.filter(names, (name) =>
      Effect.map(hasBinary(name), (present) => !present))

    yield* Effect.when(
      Console.log(
        `skipping: ${missing.join(" and ")} not installed, and CASTCLI_E2E_SKIP is set`
      ),
      Effect.succeed(missing.length > 0 && Option.isSome(skip))
    )

    yield* Effect.when(
      Effect.die(
        new Error(
          `these end-to-end tests need ${missing.join(" and ")}, which ` +
            `${missing.length === 1 ? "is" : "are"} not on PATH. Install ` +
            "them, or set CASTCLI_E2E_SKIP=1 to accept a suite that does not " +
            "test what it claims to."
        )
      ),
      Effect.succeed(missing.length > 0 && Option.isNone(skip))
    )

    return missing.length === 0
  })

/**
 * A test film: picture, sound and a subtitle track.
 *
 * Cached under `node_modules/.cache` and reused, because generating it is real
 * ffmpeg work and three tests in this file want the same thing — it was most of
 * what the file spent its time on. The name carries a version so a change to
 * what is generated does not quietly reuse the old one.
 *
 * Fifteen seconds is three HLS segments: enough for a playlist with several
 * entries and a variant switch to be possible, and no longer than that.
 *
 * The subtitles matter — they are served as a side-loaded WebVTT track rather
 * than inside the presentation, and whether a receiver fetches that when handed
 * an HLS master playlist is the kind of thing only a device can answer.
 */
const SAMPLE_VERSION = 2

export const makeSample = Effect.fn("test.makeSample")(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem
  const path = yield* Path

  const directory = path.join("node_modules", ".cache", "castcli")
  const file = path.join(directory, `sample-v${SAMPLE_VERSION}.mkv`)
  yield* fs.makeDirectory(directory, { recursive: true })

  const exists = yield* Effect.orElseSucceed(fs.exists(file), () => false)

  return yield* Effect.when(
    Effect.gen(function*() {
      const subtitles = path.join(directory, `sample-v${SAMPLE_VERSION}.srt`)
      yield* fs.writeFileString(
        subtitles,
        "1\n00:00:01,000 --> 00:00:04,000\nfirst line\n\n" +
          "2\n00:00:06,000 --> 00:00:09,000\nsecond line\n\n" +
          "3\n00:00:11,000 --> 00:00:14,000\nthird line\n"
      )

      // One pass rather than two: `-shortest` is what forced a second mux, and
      // giving each input an explicit duration removes the need for it.
      yield* spawner.string(
        ChildProcess.make("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=640x360:rate=25:duration=15",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=15",
          "-i",
          subtitles,
          "-map",
          "0:v",
          "-map",
          "1:a",
          "-map",
          "2:s",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "50",
          "-c:a",
          "aac",
          "-c:s",
          "copy",
          "-metadata:s:s:0",
          "language=eng",
          file
        ])
      )
    }),
    Effect.succeed(!exists)
  ).pipe(Effect.as(file))
})

/**
 * Poll until a condition holds, or give up.
 *
 * Generous timeouts on purpose: this spawns `npx tsx` and encodes video while
 * the rest of the suite runs alongside it, and a flake here would be blamed on
 * the code rather than on a loaded machine. They have to sum to less than the
 * test's own timeout, or the last wait is the one that fails and the message
 * says nothing about which step was slow.
 */
export const eventually = <A>(
  effect: Effect.Effect<A>,
  holds: (value: A) => boolean,
  timeout: Duration.Duration
) =>
  Effect.timeoutOption(
    Effect.repeat(effect, {
      schedule: Schedule.spaced(Duration.millis(250)),
      until: holds
    }),
    timeout
  )

/** Run the real binary at the emulator, exactly as a person would run it. */
export const play = (
  device: { readonly port: number },
  file: string,
  stateDirectory: string,
  extra: ReadonlyArray<string>,
  /** Omit `--ip` so the player has to find the device for itself. */
  byDiscovery = false
) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    Effect.forkScoped(
      Effect.flatMap(
        spawner.spawn(
            // The bundle, not the sources through tsx: it starts in 0.1s where
            // tsx takes 0.7s, and it is what `npm i -g` installs — so this
            // tests what people actually run. `npm run test:e2e` builds it.
            //
            // One process, too. `npx tsx` spawns tsx which spawns node, and
            // killing the top of that tree orphans the bottom: nine stray
            // players accumulated across runs before that was noticed, holding
            // ports and CPU until the suite starved.
            ChildProcess.make(
              process.execPath,
              [
                "dist/cast.cjs",
                "play",
                file,
                ...(byDiscovery ? [] : ["--ip", "127.0.0.1"]),
                ...extra
              ],
              {
                // The player traps SIGTERM to close its scopes tidily, and a
                // finalizer that hangs there leaves it alive — which then keeps
                // answering discovery and breaks whichever test runs next.
                // Politeness first, then force.
                forceKillAfter: "2 seconds",
                extendEnv: true,
                env: {
                  CAST_DEVICE_PORT: String(device.port),
                  CAST_ADVERTISE_HOST: "127.0.0.1",
                  XDG_STATE_HOME: stateDirectory
                }
              }
            )
        ),
        (handle) =>
          // Killed when the scope closes, whatever the fiber was doing. The
          // player never exits on its own — that is the point of it.
          // Use Effect.never to keep this alive indefinitely; the finalizer
          // will run when the test scope closes.
          Effect.zipRight(
            Effect.addFinalizer(() => Effect.orElseSucceed(handle.kill(), () => undefined)),
            Effect.never
          )
      )
    ))
