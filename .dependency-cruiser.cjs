/**
 * Architectural rules the type system cannot express.
 *
 * The layering is the point of the workspace split: domain knows nothing about
 * anyone, platform is where Node lives, and the application sits on top. A
 * cycle or an upward import compiles perfectly well — it just quietly undoes
 * the separation — so it is checked here instead.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle between modules means neither can be understood or tested alone.",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Nothing imports this. It is either dead or wired up wrong.",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)index\\.ts$", "^scripts/", "^tools/"] },
      to: {}
    },
    // Layering out of packages/domain is enforced by the `no-workspace-import`
    // lint rule instead: @castcli/protocol is not a declared dependency of
    // packages/domain, so this resolver drops such an import entirely rather
    // than reporting it, and the rule here would silently never fire.
    {
      name: "node-stays-in-platform-and-protocol",
      severity: "error",
      comment:
        "node: builtins belong behind platform (UDP, http.createServer), the " +
        "Cast TLS transport, or the emulator — which is a TLS *server* and so " +
        "is Node interop by its nature. Everywhere else uses the Effect " +
        "equivalent.",
      from: { pathNot: "^(packages/(platform|protocol|emulator|dlna)|apps/cli/src/(ControlChannel|AirPlayPlay)\\.ts|scripts|tools)" },
      // Core modules resolve to their bare name with the protocol recorded
      // separately, so match on dependencyTypes rather than the `node:` prefix.
      to: {
        dependencyTypes: ["core"],
        path: "^(dgram|tls|http|https|net|fs|child_process)$"
      }
    },
    {
      name: "packages-never-import-the-app",
      severity: "error",
      comment: "A library that reaches into its application is not a library.",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    }
  ],
  options: {
    // Third-party code is not followed, which also means it is not classified:
    // no module in this graph ever carries an `npm` or `npm-dev` dependency
    // type. A rule matching on those — there was one here, forbidding a
    // devDependency in runtime code — therefore could not fire, and was removed
    // rather than left advertising a protection it did not provide. Restoring
    // it would mean putting node_modules back in the graph and declaring
    // dependencies per workspace, which costs more than the rule is worth.
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types"] },
    reporterOptions: { text: { highlightFocused: true } }
  }
}
