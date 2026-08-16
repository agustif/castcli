/**
 * The DER envelopes Node insists on, one per curve, written out byte by byte.
 *
 * Node's Ed25519 and X25519 APIs speak `KeyObject`, and a `KeyObject` is built
 * from a key *structure* — SubjectPublicKeyInfo for a public key, PrivateKeyInfo
 * for a private one. HAP's wire format speaks 32 raw bytes. Every conversion
 * between the two is a matter of putting the right constant prefix in front of
 * the right 32 bytes, and getting the prefix subtly wrong is the single most
 * expensive mistake available in this workflow: the wrong OID still parses, still
 * round-trips against itself, and is rejected by every real device.
 *
 * So the prefixes are written here as bytes with the structure spelled out
 * beside them, rather than as a hex string copied from somewhere. A reviewer can
 * check them against RFC 8410 without running anything.
 *
 * @since 0.1.0
 */

/**
 * The two DER prefixes for one curve.
 *
 * **Details**
 *
 * Both prefixes end immediately before the raw key bytes, and every length byte
 * in them is a constant, because Ed25519 and X25519 keys are always 32 bytes.
 * That is what makes splicing legal at all — a variable-length key would need
 * the lengths recomputed, and this would have to be a DER encoder rather than a
 * constant.
 *
 * @category models
 * @since 0.1.0
 */
export interface Curve {
  /** How the curve is named in an error message. */
  readonly name: string
  /** SubjectPublicKeyInfo, up to the 32 public key bytes. */
  readonly spkiPrefix: Uint8Array
  /** PrivateKeyInfo, up to the 32 private key bytes. */
  readonly pkcs8Prefix: Uint8Array
  /** What `crypto.generateKeyPairSync` calls this curve. */
  readonly nodeType: "ed25519" | "x25519"
}

/**
 * Ed25519: OID 1.3.101.112, RFC 8410 section 3.
 *
 * ```
 * 30 2a                    SEQUENCE (42 bytes)      SubjectPublicKeyInfo
 *    30 05                 SEQUENCE (5 bytes)       algorithm
 *       06 03 2b 65 70     OID 1.3.101.112          id-Ed25519
 *    03 21 00              BIT STRING (33 bytes, 0 unused)
 *       ..32 key bytes..
 *
 * 30 2e                    SEQUENCE (46 bytes)      PrivateKeyInfo
 *    02 01 00              INTEGER 0                version
 *    30 05                 SEQUENCE (5 bytes)       privateKeyAlgorithm
 *       06 03 2b 65 70     OID 1.3.101.112          id-Ed25519
 *    04 22                 OCTET STRING (34 bytes)  privateKey, which is itself
 *       04 20              OCTET STRING (32 bytes)  CurvePrivateKey
 *          ..32 seed bytes..
 * ```
 *
 * The doubled `04` in the private form is the part that looks like a typo and is
 * not: RFC 8410 defines the `privateKey` field as an OCTET STRING whose contents
 * are themselves the DER encoding of an OCTET STRING. Dropping the inner one
 * gives a structure Node accepts on some versions and produces a key from the
 * wrong 32 bytes.
 *
 * @category models
 * @since 0.1.0
 */
export const Ed25519: Curve = {
  name: "Ed25519",
  spkiPrefix: new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
  pkcs8Prefix: new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20
  ]),
  nodeType: "ed25519"
}

/**
 * X25519: OID 1.3.101.110, RFC 8410 section 3.
 *
 * Byte for byte the Ed25519 envelope with one digit changed — `2b 65 6e` rather
 * than `2b 65 70`. That single byte is the entire difference between a key
 * agreement and a signature scheme, and it is why the two curves are separate
 * values here instead of one function taking a boolean.
 *
 * @category models
 * @since 0.1.0
 */
export const X25519: Curve = {
  name: "X25519",
  spkiPrefix: new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]),
  pkcs8Prefix: new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x04,
    0x22,
    0x04,
    0x20
  ]),
  nodeType: "x25519"
}
