// DLNA/UPnP: how a television that is not a Chromecast is told what to play.
//
// The division of labour mirrors `@castcli/protocol`. `Ssdp`, `Soap`, `Didl`
// and `Description` are pure text and testable without a network; `Discovery`
// owns the one socket; `Renderer` composes them into the operations a player
// needs. `GeneratedActions` is derived from the vendored service descriptions,
// so argument names and their order come from the specification rather than
// from memory.
export * as Actions from "./GeneratedActions.ts"
export * as Description from "./Description.ts"
export * as Didl from "./Didl.ts"
export * as Discovery from "./Discovery.ts"
export * as Renderer from "./Renderer.ts"
export * as Soap from "./Soap.ts"
export * as Ssdp from "./Ssdp.ts"
