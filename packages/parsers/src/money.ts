/**
 * Exact decimal-string → integer-cents conversion. STRING math only — this
 * module never runs parseFloat/Number arithmetic on fractional euros, so
 * "19,99" is always 1999 and never 1998.9999….
 *
 * Accepted forms:
 *   "142,80"  "142.80"      → 14280   (comma or dot decimal, 1–2 decimals)
 *   "-13,99"  "+10,00"      → signed
 *   "1.234,56"  "1,234.56"  → 123456  (thousands grouping, groups of 3)
 *   "142"                   → 14200   (integer euros)
 *   "1.234"  "12,345"       → integer euros with thousands grouping
 * Everything else throws.
 */
export function decimalToCents(s: string): number {
  const fail = (): never => {
    throw new Error(`decimalToCents: not a decimal amount: ${JSON.stringify(s)}`);
  };
  const m = /^([+-]?)([0-9.,]+)$/.exec(s.trim());
  if (!m) return fail();
  const sign = m[1] === "-" ? -1 : 1;
  const body = m[2];

  let intDigits: string;
  let decDigits: string;

  const lastSep = Math.max(body.lastIndexOf(","), body.lastIndexOf("."));
  if (lastSep === -1) {
    // plain integer euros
    intDigits = body;
    decDigits = "00";
  } else {
    const sepChar = body[lastSep];
    const tail = body.slice(lastSep + 1);
    if (tail.length === 3) {
      // thousands grouping only: e.g. "1.234", "12,345", "12.345.678"
      const grouped = new RegExp(`^\\d{1,3}(\\${sepChar}\\d{3})+$`);
      if (!grouped.test(body)) return fail();
      intDigits = body.split(sepChar).join("");
      decDigits = "00";
    } else if (tail.length === 1 || tail.length === 2) {
      decDigits = tail.length === 1 ? tail + "0" : tail;
      const head = body.slice(0, lastSep);
      const otherSep = sepChar === "," ? "." : ",";
      if (head.includes(sepChar)) return fail(); // "12.3.4"
      if (head.includes(otherSep)) {
        // thousands-grouped integer part: "1.234,56" / "1,234.56"
        const grouped = new RegExp(`^\\d{1,3}(\\${otherSep}\\d{3})+$`);
        if (!grouped.test(head)) return fail();
        intDigits = head.split(otherSep).join("");
      } else {
        intDigits = head;
      }
    } else {
      return fail(); // "12," or ≥4 decimals
    }
  }

  if (!/^\d+$/.test(intDigits) || !/^\d{2}$/.test(decDigits)) return fail();
  if (intDigits.length > 13) return fail(); // beyond safe-integer cents territory
  return sign * (Number(intDigits) * 100 + Number(decDigits));
}
