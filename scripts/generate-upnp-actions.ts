// Generates the UPnP action surface from the vendored service descriptions.
//
// A UPnP service publishes its own contract: an SCPD document listing every
// action, every argument, and which direction each one travels. That is a
// machine-readable first source, and the alternative — transcribing argument
// names and their order out of a PDF — is exactly the kind of thing that is
// correct on the day it is written and wrong a year later.
//
// The order matters more than it looks. A SOAP request carries arguments
// positionally inside the action element, so `SetAVTransportURI` with its URI
// and metadata the wrong way round is a well-formed request that a television
// accepts and then does nothing with. Generating the builders from the
// declaration means the compiler knows the names, and nothing has to remember
// the order.
//
//   npm run codegen        regenerate
//   npm run codegen:check  fail if the checked-in output is stale
//
// The vendored SCPDs are the standardised AVTransport:1 and RenderingControl:1
// service templates. A real device serves its own copy at the SCPDURL in its
// description, which may differ — vendors add actions and, rarely, omit them —
// so this is the contract we *require*, not an inventory of what any particular
// television offers.

import { Effect, Schema } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { XMLParser } from "fast-xml-parser"
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUTPUT = path.join(ROOT, "packages/dlna/src/GeneratedActions.ts")

interface Source {
  readonly file: string
  readonly serviceType: string
  readonly constant: string
  readonly description: string
}

const SOURCES: ReadonlyArray<Source> = [
  {
    file: "packages/dlna/vendor/AVTransport1.scpd.xml",
    serviceType: "urn:schemas-upnp-org:service:AVTransport:1",
    constant: "AVTransport",
    description: "Loading media and controlling playback."
  },
  {
    file: "packages/dlna/vendor/RenderingControl1.scpd.xml",
    serviceType: "urn:schemas-upnp-org:service:RenderingControl:1",
    constant: "RenderingControl",
    description: "Volume and mute."
  }
]

interface Action {
  readonly name: string
  readonly args: ReadonlyArray<{ readonly name: string; readonly direction: "in" | "out" }>
}

const parser = new XMLParser({
  ignoreAttributes: false,
  // Names and directions are text and must stay text: an argument called `1`
  // would otherwise arrive as a number and stop matching anything.
  parseTagValue: false,
  // A service with a single action or a single argument would otherwise parse
  // as an object rather than a list of one, and every consumer would need to
  // handle both shapes.
  isArray: (name) => name === "action" || name === "argument"
})

/**
 * The shape of an SCPD, decoded rather than trusted.
 *
 * These documents come from outside — the vendored copies today, a device's own
 * copy tomorrow — and a silently missing `direction` would put an output
 * argument into the request, which a television answers by doing nothing.
 */
const ScpdArgument = Schema.Struct({
  name: Schema.String,
  direction: Schema.Literals(["in", "out"])
})

const ScpdAction = Schema.Struct({
  name: Schema.String,
  argumentList: Schema.optional(
    Schema.Struct({ argument: Schema.Array(ScpdArgument) })
  )
})

const Scpd = Schema.Struct({
  scpd: Schema.Struct({
    actionList: Schema.Struct({ action: Schema.Array(ScpdAction) })
  })
})

const decodeScpd = Schema.decodeUnknownEffect(Scpd)

const actionsIn = (xml: string) =>
  Effect.map(decodeScpd(parser.parse(xml)), (document) =>
    document.scpd.actionList.action.map((action): Action => ({
      name: action.name,
      args: action.argumentList?.argument ?? []
    })))

/** `SetAVTransportURI` becomes `setAVTransportURI`. */
const camel = (name: string): string => `${name.charAt(0).toLowerCase()}${name.slice(1)}`

const renderOutputs = (
  action: string,
  outputs: ReadonlyArray<{ readonly name: string }>
): string => {
  const names = outputs.map((output) => JSON.stringify(output.name))
  const inline = `export const ${camel(action)}Outputs = [${names.join(", ")}] as const`
  return inline.length <= 100
    ? inline
    : `export const ${camel(action)}Outputs = [\n${
      names.map((name) => `  ${name}`).join(",\n")
    }\n] as const`
}

const renderAction = (service: string, action: Action): string => {
  const inputs = action.args.filter((argument) => argument.direction === "in")
  const outputs = action.args.filter((argument) => argument.direction === "out")

  // Wrapped when the record would run past a hundred columns, which most of
  // these do — several actions take five or six arguments.
  const fields = inputs.map((argument) => `readonly ${argument.name}: string`)
  const inline = `args: { ${fields.join("; ")} }`
  // Measured against the whole declaration, not the record alone: the name and
  // the return type are part of the line too, and ignoring them put five
  // signatures over the limit.
  const declaration = `export const ${camel(action.name)} = (${inline}): Action => ({`
  const parameters = inputs.length === 0
    ? "()"
    : declaration.length <= 100
    ? `(${inline})`
    : `(args: {
${fields.map((field) => `  ${field}`).join("\n")}
})`

  const pairs = inputs.map((argument) =>
    `    [${JSON.stringify(argument.name)}, args.${argument.name}]`
  )

  // Wrapped rather than truncated: the answer list is the useful half of the
  // comment, and a reader should not have to open the SCPD to see it.
  const answering = outputs.map((output) => output.name).join(", ")
  const oneLine = `/** \`${action.name}\`, answering ${answering}. */`
  const summary = outputs.length === 0
    ? `/** \`${action.name}\`. */`
    : oneLine.length <= 100
    ? oneLine
    : `/**\n * \`${action.name}\`, answering:\n${
      outputs.map((output) => ` * ${output.name}`).join("\n")
    }\n */`

  return [
    summary,
    `export const ${camel(action.name)} = ${parameters}: Action => ({`,
    `  service: ${service},`,
    `  name: ${JSON.stringify(action.name)},`,
    inputs.length === 0 ? "  args: []" : `  args: [\n${pairs.join(",\n")}\n  ]`,
    `})`,
    ``,
    `/** Output argument names of \`${action.name}\`, in declared order. */`,
    renderOutputs(action.name, outputs),
    ``
  ].join("\n")
}

const render = Effect.gen(function*() {
  const sections = yield* Effect.forEach(SOURCES, (source) =>
    Effect.gen(function*() {
    const actions = yield* actionsIn(readFileSync(path.join(ROOT, source.file), "utf8"))
    return [
      `// --- ${source.constant} ${"-".repeat(Math.max(0, 66 - source.constant.length))}`,
      ``,
      `/** ${source.description} */`,
      `export const ${source.constant} = ${JSON.stringify(source.serviceType)}`,
      ``,
      ...actions.map((action) => renderAction(source.constant, action))
      ].join("\n")
    }))

  return [
    "// Generated from the vendored UPnP service descriptions. Do not edit.",
    "//",
    ...SOURCES.map((source) => `// Source: ${source.file}`),
    "//",
    "// A SOAP request carries its arguments positionally, so an action built with",
    "// them in the wrong order is a well-formed request that a television accepts",
    "// and ignores. These builders take a named record and put them in the order",
    "// the service declared, which is why they are generated rather than written.",
    "//",
    "//   npm run codegen   regenerate from packages/dlna/vendor",
    "",
    `import type { Action } from "./Soap.ts"`,
    "",
    ...sections
  ].join("\n")
})

const main = Effect.gen(function*() {
  const rendered = yield* render

  return yield* process.argv.includes("--check")
    ? Effect.gen(function*() {
      const existing = yield* Effect.try({
        try: () => readFileSync(OUTPUT, "utf8"),
        catch: () =>
          new Error(`${path.relative(ROOT, OUTPUT)} is missing — run \`npm run codegen\``)
      })
      return yield* existing === rendered
        ? Effect.logInfo("upnp actions are up to date")
        : Effect.fail(
          new Error(`${path.relative(ROOT, OUTPUT)} is stale — run \`npm run codegen\``)
        )
    })
    : Effect.gen(function*() {
      writeFileSync(OUTPUT, rendered)
      yield* Effect.logInfo(`wrote ${path.relative(ROOT, OUTPUT)}`)
    })
})

NodeRuntime.runMain(main)
