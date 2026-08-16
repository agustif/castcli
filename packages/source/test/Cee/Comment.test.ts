// Blanking commentary without damaging the code around it.

import { assert, describe, it } from "@effect/vitest"
import { withoutComments } from "../../src/Cee/Comment.ts"

describe("Cee withoutComments", () => {
  it("leaves a comment marker inside a string literal alone", () => {
    // The failure this guards against is not cosmetic. Truncating the string
    // leaves an unterminated quote, and everything after it on the line — and
    // in the file, until the next quote — swaps its idea of what is code and
    // what is text.
    const source = `const char* u = "http://example/a"; // real comment`
    assert.include(withoutComments(source), `"http://example/a"`)
    assert.notInclude(withoutComments(source), "real comment")
  })

  it("does not read an apostrophe in a comment as a character literal", () => {
    // "don't" inside a comment, then code. If the apostrophe started a
    // character literal, it would run to the next one and swallow the
    // declaration between them.
    const source = ["// don't do this", "int x = 1;", "// or that's fine"].join("\n")
    assert.include(withoutComments(source), "int x = 1;")
  })

  it("keeps every remaining character at its original line and column", () => {
    // Comments are blanked rather than deleted. A declaration that followed a
    // block comment on the same line must not slide up against what preceded
    // it, or a reader can match across what used to be two statements.
    const source = "int a = 1; /* note */ int b = 2;"
    const stripped = withoutComments(source)
    assert.strictEqual(stripped.length, source.length)
    assert.strictEqual(stripped.indexOf("int b"), source.indexOf("int b"))
  })

  it("blanks a block comment without joining the lines it spanned", () => {
    const source = ["int a;", "/* one", "   two */", "int b;"].join("\n")
    assert.strictEqual(withoutComments(source).split("\n").length, 4)
  })
})
