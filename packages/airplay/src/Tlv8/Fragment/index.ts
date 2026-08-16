// Fragmentation: the two halves of the rule that a value longer than one
// length byte is written as several items of the same type.
//
// Split and Join are inverses and each is a paragraph of reasoning, so they
// are separate files; what makes them a directory is that neither is
// meaningful without the other. The empty terminating fragment that `split`
// emits exists only because of how `join` ends a run, and a change to either
// rule that is not made in both corrupts the wire in a way no type catches.

export * from "./Join.ts"
export * from "./Split.ts"
