// C enums: the numbers a protocol is actually made of.
//
// TLV types, method codes, error codes, flag bits — every one of them is a
// small integer that has to match the other end exactly, and every one of them
// is written down in somebody's header. Reading them from there rather than
// retyping them is the difference between a vocabulary that is right today and
// one that stays right.
//
//   Member      what comes out: { name, value }
//   Expression  what a C compiler would fold the initialiser to
//   Codec       the two together, as a Schema over the text of a C file
//
// `Expression` is exported because it is testable on its own and because a
// caller reading a `#define`d constant expression has the same problem.

export { enumeration } from "./Codec.ts"
export * as Expression from "./Expression.ts"
export { Member, Members } from "./Member.ts"
