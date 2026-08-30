import { describe, expect, it } from "vitest";
import { senderAddress } from "./gmail";

/**
 * The shape table for `senderAddress` — PURE, no database, no ingest.
 *
 * Every other test of this function pays a Postgres round-trip through
 * `ingestRawEmail`, which is exactly why its shape coverage stayed thin
 * enough to hide two Critical findings for a whole review round: a header
 * shape costs a transaction, a vault write and a document read, so nobody
 * writes twenty of them. Here one row costs a function call.
 *
 * `A` is the mailbox each hostile header REALLY names. `D` is the decoy: the
 * address of a watched party, planted somewhere a sloppy parser might pick it
 * up. The law of this file, asserted separately at the bottom over every row:
 * NO input may ever resolve to `D` — except the one row that is literally
 * nothing but `D`.
 */
const A = "attacker@evil.tld";
const D = "demi@verdergroep.nl";

/** [name, header, expected] */
const CASES: [string, string, string | null][] = [
  // ---- resolves to the real mailbox -------------------------------------
  ["bare angle pair", `<${A}>`, A],
  ["display name", `Demi <${A}>`, A],
  ["quoted display name that IS the decoy address", `"${D}" <${A}>`, A],
  ["quoted display name containing a comma", `"Doe, John" <${A}>`, A],
  ["quoted display name containing angle brackets", `"<${D}>" <${A}>`, A],
  // A quoted-pair inside the quoted string: the escaped `"` does NOT end the
  // display name, so `<D>` stays inside it and never reaches the top level.
  ["quoted-pair hiding the decoy in the display name", `"he said \\" <${D}>" <${A}>`, A],
  // Invented (self-review): the whole decoy angle pair sits inside a quoted
  // display name whose opening quote is itself escaped shut later.
  ["escaped quote wrapping a decoy angle pair", `"\\" <${D}>" <${A}>`, A],
  ["RFC 2047 encoded-word display name", `=?UTF-8?B?RGVtaSBXaWxsZW1zZQ==?= <${A}>`, A],
  ["folded header (CRLF + WSP)", `Demi\r\n <${A}>`, A],
  // Invented (self-review): case folding is ASCII-only but it does happen.
  ["uppercase addr-spec folds to ASCII lower case", `<${A.toUpperCase()}>`, A],

  // ---- bare addresses ---------------------------------------------------
  ["bare address (decoy's own, legitimately)", D, D],
  ["bare address (attacker's own)", A, A],

  // ---- refused: parentheses anywhere ------------------------------------
  // Ruling 12: a `(` or `)` ANYWHERE refuses the header. Comments nest and
  // take quoted-pair escapes; a stripper for them manufactured addresses and
  // leaked decoys twice, so there is no stripper any more.
  ["trailing comment", `<${A}> (${D})`, null],
  ["leading comment", `(${D}) <${A}>`, null],
  // Fully VALID RFC 5322: the comment is ` \) <D> \( ` — both parens inside
  // it are quoted-pairs and close nothing. A depth-counting stripper ends the
  // comment at the first `\)` and hands `<D>` to the top level.
  ["comment using quoted-pair escapes", `<${A}> ( \\) <${D}> \\( )`, null],
  ["comment opening with a quoted-pair, then an empty comment", `<${A}> (\\) <${D}> ()`, null],
  ["comment containing a lone double quote", `<${A}> (")<${D}>`, null],
  ["comment used as a separator between two mailboxes", `<${A}>(,)<${D}>`, null],
  ["parenthesis inside a quoted display name", `"a (b) c" <${A}>`, null],
  // The one that broke the "never manufacture an address" claim: stripping
  // `(x)` here produces `attacker@evil.tld`, which appears nowhere in the
  // input. Refusing is the only honest answer.
  ["parenthesis inside a bare address", `att(x)acker@evil.tld`, null],
  ["unterminated comment", `Demi (unterminated <${D}>`, null],

  // ---- refused: not exactly one mailbox ---------------------------------
  ["two angle pairs, no comma", `<${A}> <${D}>`, null],
  // Invented (self-review): a tab instead of a space, in case anything ever
  // reduces to splitting on " ".
  ["two angle pairs separated by a tab", `<${A}>\t<${D}>`, null],
  ["nested angle brackets", `<<${D}>>`, null],
  ["two bare addresses", `${D}, ${A}`, null],
  ["mailbox list with the decoy second", `<${A}>, ${D}`, null],
  ["group syntax, empty", `undisclosed-recipients:;`, null],
  ["group syntax with members", `Group: a@x.nl, b@y.nl;`, null],
  // The one that makes the `:`/`;` rule load-bearing: without it this header
  // has exactly one angle pair and would resolve to the decoy.
  ["group syntax wrapping the decoy", `Group: <${D}>;`, null],

  // ---- refused: malformed ----------------------------------------------
  ["unterminated quoted string", `"abc <${A}>`, null],
  ["stray closing angle bracket", `${D}>`, null],
  ["unterminated opening angle bracket", `Demi <${D}`, null],
  ["empty header", ``, null],
  ["empty angle pair", `<>`, null],
  ["whitespace only", `   `, null],
  // Invented (self-review): `angle-addr` allows only CFWS after the `>`, and
  // comments are refused, so trailing text is unaccounted for.
  ["trailing text after the angle pair", `<${A}> ${D}`, null],
  ["not an address at all", `not an address`, null],
  // relevance.ts's own finding: U+212A KELVIN SIGN lower-cases to ASCII "k"
  // under `String.toLowerCase()`, which would fold a sender-chosen header into
  // a watched address. `asciiLower` leaves it alone and the shape check then
  // rejects it.
  ["KELVIN SIGN in the domain", `<incasso@\u212Avk.nl>`, null],
];

describe("senderAddress", () => {
  it.each(CASES)("%s", (_name, header, expected) => {
    expect(senderAddress(header)).toBe(expected);
  });

  it("never resolves to the decoy address, whatever the header shape", () => {
    for (const [name, header] of CASES) {
      if (header === D) continue; // the one row that legitimately names D
      expect(senderAddress(header), name).not.toBe(D);
    }
  });
});
