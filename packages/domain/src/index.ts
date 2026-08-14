// The vocabulary every other package speaks.
//
// Brands are exported both flat and namespaced: `Ipv4` and `Seconds` are
// distinctive enough to stand alone at a call site, while `Ipv4.make(...)`
// reads better where a constructor is meant.
export * from "./Brands.ts"
export * as Brands from "./Brands.ts"
export * from "./Errors.ts"
export * from "./Device.ts"
export * from "./Media.ts"
export { describe as describeRung, Rung } from "./Rung.ts"
