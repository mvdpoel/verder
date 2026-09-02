import { describe, expect, it } from "vitest";
import { looksLikeProse, stopwordShare } from "./text-quality";

describe("looksLikeProse", () => {
  // Verbatim from asml.pdf, which was scanned upside down. The model, shown
  // this, answered "Beschikking.UWV" with confident:true.
  const GARBLED = `Ev ods E AE - O5 3 od 1 1 BL | - : fs 783 g TIL go. vie 33 |
    - 22 = = 8s o gm iF ej J ---- ou D = : 7 | 4 ] | 33 | <3 | | | 3 fe] 5
    De HH | Bg Td | 5 = 1 q : *. : 5 2 = | wa . 5 4 br. ee g 3 ; % ie 9 X TT
    1 van UM ly :99e|d {202 <o- 1% aeg ) Nn :emnjeuSig uorpoIpsin[ SAISN[9Xe
    BABY [IM LNOD YIJNG Jusladwiod ay] me] yang Aq e= SI U uspun sIuL 2
    SME| S8)jLINJ8s pue eje10d109 eqeoijdde Ie 0} Juensind suonebiigo ay)`;

  const REAL = `Geachte heer Van der Poel, hierbij bevestigen wij de ontvangst
    van uw verzoek. Wij hebben uw aanvraag in behandeling genomen en zullen u
    binnen vier weken informeren over het besluit dat is genomen. Indien u het
    niet eens bent met dit besluit kunt u bezwaar maken bij de rechtbank in
    het arrondissement waar u woont. De termijn voor het indienen van een
    bezwaarschrift bedraagt zes weken na de datum van deze beschikking.`;

  it("refuses upside-down OCR", () => {
    expect(looksLikeProse(GARBLED)).toBe(false);
  });

  it("accepts an ordinary Dutch letter", () => {
    expect(looksLikeProse(REAL)).toBe(true);
  });

  it("accepts English contract text", () => {
    expect(looksLikeProse(`The Recipient shall immediately inform ASML of any
      inventions made and shall execute all documents required for perfecting
      the transfer to ASML of all ownership rights, without any compensation
      from ASML except for expenses agreed. At the first request of ASML the
      Recipient shall fully assist in establishing such rights.`)).toBe(true);
  });

  it("refuses text too short to judge", () => {
    expect(looksLikeProse("de van het een")).toBe(false);
    expect(looksLikeProse("")).toBe(false);
  });

  // The sparse end of "real": a payslip is a table of numbers and labels and
  // measured 4.9% on this share; refusing it would be a false positive.
  it("accepts a document that is a table rather than prose", () => {
    const payslip = ("Periode Loon Uren Tarief Bruto Netto Heffingskorting "
      + "Pensioenpremie Vakantiegeld Reiskosten Werkgever Werknemer Bedrag "
      + "Cumulatief Loonheffing Arbeidskorting Grondslag Premie Totaal ")
      .repeat(3) + " van het de";  // 3 of 60 words = 5.0%, the real one is 4.9%
    expect(looksLikeProse(payslip)).toBe(true);
  });
});

describe("stopwordShare", () => {
  it("is zero for text too short to measure", () => {
    expect(stopwordShare("de van het een")).toBe(0);
    expect(stopwordShare("")).toBe(0);
  });

  // The separation the threshold sits in, measured on the real corpus.
  it("separates garbled OCR from readable text", () => {
    const readable = ("Geachte heer Van der Poel wij bevestigen de ontvangst van "
      + "uw verzoek en wij hebben dat in behandeling genomen ").repeat(4);
    expect(stopwordShare(readable)).toBeGreaterThan(0.047);
  });
});
