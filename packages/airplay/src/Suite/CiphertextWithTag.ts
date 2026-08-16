/**
 * The layout HAP puts a sealed frame in: ciphertext, then tag.
 *
 * @since 0.1.0
 */

/**
 * Ciphertext with its 16-byte Poly1305 tag appended, as one buffer.
 *
 * **Details**
 *
 * Named rather than left as `Uint8Array` because the alternative layouts are
 * real and produce silent failures. Node's own API hands back ciphertext and tag
 * separately; libsodium's `crypto_aead_*_encrypt` appends the tag as this does;
 * some AirPlay-adjacent code prepends it. Only one of those is what HAP writes,
 * and a reader of a signature that said `Uint8Array` would have no way to tell
 * which this is — the length is right in every case, and the only symptom of
 * choosing wrong is a frame that will not authenticate.
 *
 * HAP appends: the vendored `HAPPairingPairSetup.c` writes the tag at
 * `&bytes[numBytes]` and then adds `CHACHA20_POLY1305_TAG_BYTES` to the length,
 * so a sealed frame is exactly `plaintext.length + Sizes.TAG` bytes and the tag
 * is the last sixteen of them.
 *
 * **Gotchas**
 *
 * This is a type alias, not a brand — it documents a layout, it does not enforce
 * one. A plain `Uint8Array` is assignable to it.
 *
 * @category models
 * @since 0.1.0
 */
export type CiphertextWithTag = Uint8Array
