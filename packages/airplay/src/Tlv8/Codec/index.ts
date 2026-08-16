// The payload codec: bytes in one direction, items in the other.
//
// `Items` is the whole of this directory's contract. `read` and `write` are
// exported beside it because each is separately testable and separately
// wrong-able — truncation detection lives in one and the length byte in the
// other — but nothing outside `Tlv8` should reach for them: used on their own
// they skip fragmentation, which is the half of the format that is easy to get
// wrong and impossible to notice.

export * from "./Items.ts"
export * from "./Read.ts"
export * from "./Write.ts"
