// TLV8: the framing every HomeKit and AirPlay pairing message is written in.
//
// A one-byte type, a one-byte length, then that many bytes of value, repeated
// until the payload runs out. It is small enough to write from the description
// and wrong enough, written that way, to fail against real hardware in ways
// that look like cryptography failing:
//
//   - a value longer than 255 bytes is several items of the same type, and a
//     reader that does not rejoin them verifies a proof against the first 255
//     bytes of a key (../Tlv8/Fragment/);
//   - a reader that rejoins by type alone instead of by adjacency turns a list
//     of pairings into one pairing with an impossible identifier (ditto);
//   - `kTLVType_Separator` is a zero-length item and means everything by where
//     it is (./Query/Groups.ts).
//
// This is the substrate for the rest of pairing — SRP, the encrypted sub-TLVs
// inside `kTLVType_EncryptedData`, and pair-verify all sit on top of it — so
// it is stated as a Schema codec that runs in both directions, and the round
// trip is the check that the reader and the writer agree about the format
// rather than each being self-consistently wrong.
//
// The item type vocabulary is not restated here: it is generated from Apple's
// header into `../GeneratedPairing.ts` as `TlvType`.

export * from "./Codec/Items.ts"
export * from "./Item.ts"
export * from "./Query/index.ts"
