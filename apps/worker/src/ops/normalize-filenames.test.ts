import { describe, expect, it } from "vitest";
import { buildNamePrompt, identifierTokens, retainsIdentifiers, validateName } from "./normalize-filenames";
import { looksLikeProse } from "../text-quality";

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

