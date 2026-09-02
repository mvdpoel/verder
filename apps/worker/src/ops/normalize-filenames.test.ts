import { describe, expect, it } from "vitest";
import { buildNamePrompt, identifierTokens, looksLikeProse, retainsIdentifiers, validateName } from "./normalize-filenames";

describe("validateName", () => {
  const none = () => new Set<string>();

  it("accepts a name in the archive convention and keeps the extension", () => {
    expect(validateName("Arbeidsovereenkomst.Airteq.MP.van.der.Poel", "scan0063.pdf", none()))
      .toBe("Arbeidsovereenkomst.Airteq.MP.van.der.Poel.pdf");
  });

  it("does not double the extension when the model already supplied one", () => {
    expect(validateName("Jaaropgave.UWV.2024.pdf", "scan0049.pdf", none()))
      .toBe("Jaaropgave.UWV.2024.pdf");
  });

  // The name becomes a path on a share mounted over NFS and SMB. A model that
  // is talked into emitting a traversal must not be able to move a file out of
  // the scan folder, and basename() is what stops it.
  it("refuses path traversal and separators", () => {
    for (const evil of ["../../etc/passwd", "a/b", "..", "/absolute", "x\\y"]) {
      const out = validateName(evil, "scan0001.pdf", none());
      expect(out === null || (!out.includes("/") && !out.includes("\\"))).toBe(true);
    }
    expect(validateName("../../etc/passwd", "scan0001.pdf", none())).toBe("passwd.pdf");
  });

  it("refuses characters a Windows client cannot open", () => {
    for (const bad of ["a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateName(bad, "scan0001.pdf", none())).toBeNull();
    }
  });

  it("refuses a leading dot, an empty stem and a non-string", () => {
    expect(validateName(".hidden", "scan0001.pdf", none())).toBe("hidden.pdf");
    expect(validateName("   ", "scan0001.pdf", none())).toBeNull();
    expect(validateName("", "scan0001.pdf", none())).toBeNull();
    expect(validateName(null, "scan0001.pdf", none())).toBeNull();
    expect(validateName(42, "scan0001.pdf", none())).toBeNull();
  });

  it("refuses a collision, so two documents never claim one filename", () => {
    const taken = new Set(["jaaropgave.uwv.2024.pdf"]);
    expect(validateName("Jaaropgave.UWV.2024", "scan0049.pdf", taken)).toBeNull();
  });

  it("refuses a no-op rename", () => {
    expect(validateName("scan0063", "scan0063.pdf", none())).toBeNull();
  });

  it("refuses an absurdly long name", () => {
    expect(validateName("A".repeat(200), "scan0001.pdf", none())).toBeNull();
  });

  it("collapses whitespace rather than emitting a name with spaces", () => {
    expect(validateName("Akte van oprichting Pull IT BV", "scan0002.pdf", none()))
      .toBe("Akte.van.oprichting.Pull.IT.BV.pdf");
  });
});

describe("buildNamePrompt", () => {
  it("carries the current name and the text, and bounds the text", () => {
    const p = buildNamePrompt("scan0063.pdf", "X".repeat(9000));
    expect(p).toContain("scan0063.pdf");
    expect(p).toContain("Arbeidsovereenkomst.Airteq.MP.van.der.Poel.2026.pdf");
    expect(p.length).toBeLessThan(8000);
  });
});

describe("validateName, accented Dutch", () => {
  // "Beeindigingsovereenkomst" carries an e-diaeresis and is one of the
  // commonest document types in this archive. An ASCII-only allowlist refused
  // it twice in the first production run.
  it("accepts the accented characters Dutch documents actually use", () => {
    expect(validateName(
      "Be\u00EBindigingsovereenkomst.Accenture.MP.van.der.Poel.2023", "vso.tdn.pdf", new Set()))
      .toBe("Be\u00EBindigingsovereenkomst.Accenture.MP.van.der.Poel.2023.pdf");
    expect(validateName("Verklaring.Caf\u00E9.Z\u00FCrich", "scan1.pdf", new Set()))
      .toBe("Verklaring.Caf\u00E9.Z\u00FCrich.pdf");
  });

  it("normalises to NFC so one filename has one byte form", () => {
    const decomposed = "Be\u00EBindiging.Test".normalize("NFD");
    const out = validateName(decomposed, "scan1.pdf", new Set())!;
    expect(out).toBe(out.normalize("NFC"));
    expect(out).toBe("Be\u00EBindiging.Test.pdf");
  });

  // A newline is whitespace, so it is COLLAPSED to the separator rather than
  // refused — the character never reaches the filesystem either way. A control
  // character that is not whitespace has no such path and is refused outright.
  it("collapses whitespace-like control characters and refuses the rest", () => {
    expect(validateName("a" + String.fromCharCode(10) + "b", "scan1.pdf", new Set()))
      .toBe("a.b.pdf");
    for (const code of [0, 1, 7, 27]) {
      expect(validateName("a" + String.fromCharCode(code) + "b", "scan1.pdf", new Set()))
        .toBeNull();
    }
  });
});

describe("identifierTokens", () => {
  it("keeps what distinguishes a document and drops what does not", () => {
    expect(identifierTokens("machtiging.carolien.pdf")).toEqual(["carolien"]);
    expect(identifierTokens("verhuurdersverklaring.slauerhoffstraat.203.pdf"))
      .toEqual(["slauerhoffstraat", "203"]);
    expect(identifierTokens("Loonheffing.MP.SaurensMarketing.pdf"))
      .toEqual(["saurensmarketing"]);
  });

  it("treats an opaque scan name as carrying nothing", () => {
    expect(identifierTokens("scan0063.pdf")).toEqual([]);
    expect(identifierTokens("IMG_2231.pdf")).toEqual([]);
    expect(identifierTokens("scan_0007.pdf")).toEqual([]);
  });

  it("lets a document-type word be replaced by a better one", () => {
    expect(identifierTokens("Accenture.vaststellingovereenkomst.pdf"))
      .toEqual(["accenture"]);
  });
});

describe("retainsIdentifiers", () => {
  // Each of these is a rename the first production run actually made.
  it("allows an abbreviation to be expanded", () => {
    expect(identifierTokens("vso.tdn.pdf")).toEqual([]);
    expect(retainsIdentifiers("vso.tdn.pdf",
      "Beeindigingsovereenkomst.TrueFullstaq.mp.2026.pdf")).toBe(true);
  });

  it("does not insist on Martin's own name, which distinguishes nothing", () => {
    expect(identifierTokens("2023 ARB OK CloudNation Martin van der Poel.pdf"))
      .toEqual(["cloudnation"]);
  });

  it("rejects the renames that lost information", () => {
    expect(retainsIdentifiers("machtiging.carolien.pdf", "Machtiging.pdf")).toBe(false);
    expect(retainsIdentifiers(
      "verhuurdersverklaring.slauerhoffstraat.203.pdf", "Verhuurdersverklaring.2023.pdf")).toBe(false);
    expect(retainsIdentifiers(
      "Loonheffing.MP.SaurensMarketing.pdf",
      "Opgaaf.ggevens.loonheffingen.Belastingdienst.MP.van.der.Poel.2026.pdf")).toBe(false);
  });

  it("accepts a rename that keeps every identifier and improves the type", () => {
    expect(retainsIdentifiers("machtiging.carolien.pdf", "Machtiging.LBIO.Carolien.pdf")).toBe(true);
    expect(retainsIdentifiers(
      "Accenture.vaststellingovereenkomst.pdf",
      "Bee\u0308indigingsovereenkomst.Accenture.MP.van.der.Poel.2023.pdf".normalize("NFC"))).toBe(true);
  });

  it("matches across separator differences", () => {
    expect(retainsIdentifiers("x.SaurensMarketing.pdf", "Nota.Saurens-Marketing.2026.pdf")).toBe(true);
  });

  it("imposes nothing on an opaque name", () => {
    expect(retainsIdentifiers("scan0063.pdf", "Arbeidsovereenkomst.Airteq.pdf")).toBe(true);
  });
});

describe("validateName enforces retention", () => {
  it("refuses a proposal that drops the distinguishing part", () => {
    expect(validateName("Machtiging", "machtiging.carolien.pdf", new Set())).toBeNull();
    expect(validateName("Machtiging.LBIO.Carolien", "machtiging.carolien.pdf", new Set()))
      .toBe("Machtiging.LBIO.Carolien.pdf");
  });
});

describe("buildNamePrompt states the convention", () => {
  it("names the words that must survive", () => {
    const p = buildNamePrompt("machtiging.carolien.pdf", "tekst over LBIO");
    expect(p).toContain("MOETEN terugkomen: carolien");
    expect(p).toContain("LANGE NAMEN ZIJN PRIMA");
  });
});

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
