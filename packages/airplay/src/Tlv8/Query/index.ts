// Getting values back out of a decoded payload.
//
// Three questions, because a TLV8 message answers three shapes of question and
// each is wrong in its own way if asked the naive way: which value has this
// type (not: which item is at this index), what small number does this item
// hold (not: what is its first byte), and where does one entry of a list end
// (not: how many items of this type are there).

export * from "./Byte.ts"
export * from "./Find.ts"
export * from "./Groups.ts"
