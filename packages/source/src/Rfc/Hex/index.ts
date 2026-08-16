// Large numbers, as an RFC prints them.
//
// A 3072-bit prime does not fit on a line, so the RFC editor lays it out in six
// columns of eight digits. That layout is the only signal separating the number
// from the prose around it, and it is the thing this directory knows:
// `Columns` states it, `Digits` reads and writes it, `Number` turns the digits
// into the arithmetic the value exists for.

export { HexDigits } from "./Digits.ts"
export { BigIntFromHexDigits } from "./Number.ts"
