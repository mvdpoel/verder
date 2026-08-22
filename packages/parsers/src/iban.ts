/**
 * Account-number normalization.
 *
 * ABN AMRO writes the same account two ways: the legacy nine-digit
 * rekeningnummer ("56.65.67.741") at the head of a statement and in column 0
 * of the TSV/Excel exports, and the official IBAN ("NL12ABNA0566567741") in
 * CAMT.053 and on a payslip. Both notations reach `transactions.account_iban`,
 * and /money groups its series by that exact string — so without a single
 * spelling, one real account imported through two containers becomes two
 * accounts, with the income on one and the costs on the other.
 *
 * Everything here is plain string and BigInt arithmetic. No money, no floats.
 */

/** A→10 … Z→35, per ISO 13616. */
function toDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code >= 65 && code <= 90 ? String(code - 55) : ch;
  }
  return out;
}

/**
 * The two check digits for a BBAN, computed rather than trusted: move the
 * country code and "00" to the end, letters become numbers, then 98 − mod 97.
 * BigInt because the intermediate is far past Number.MAX_SAFE_INTEGER.
 */
export function ibanCheckDigits(bban: string, country = "NL"): string {
  const n = BigInt(toDigits(bban.toUpperCase() + country + "00"));
  return String(98n - (n % 97n)).padStart(2, "0");
}

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/;
/** A Dutch BBAN is exactly ten digits; the legacy numbers are nine or fewer. */
const NL_ACCOUNT_DIGITS = 10;

/**
 * One spelling for an account, whichever notation it arrived in.
 *
 * - an IBAN keeps its own bank and check digits, whoever exported it
 * - a legacy Dutch account number becomes `NL<check><bankCode><10 digits>`
 * - anything else is returned unchanged: it is still a usable grouping key,
 *   and fabricating check digits for something that is not an account number
 *   would be worse than admitting we do not know
 *
 * `bankCode` is the four-letter code of the bank whose export is being read —
 * only the caller knows that, and only a legacy number needs it.
 */
export function normalizeAccount(raw: string | null | undefined, bankCode: string): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const compact = trimmed.replace(/[\s.]/g, "").toUpperCase();
  if (compact === "") return null;
  if (IBAN_SHAPE.test(compact)) return compact;

  if (/^\d+$/.test(compact) && compact.length <= NL_ACCOUNT_DIGITS) {
    const bban = bankCode.toUpperCase() + compact.padStart(NL_ACCOUNT_DIGITS, "0");
    return `NL${ibanCheckDigits(bban)}${bban}`;
  }
  return trimmed;
}
