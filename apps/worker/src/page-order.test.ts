import { describe, expect, it } from "vitest";
import { detectPageOrder, findPageMarkers } from "./page-order";

/** Footers as they actually appear on the Belastingdienst letter. */
const foot = (n: number) => `INL230-07 / V013                Paginanummer ${n} van 6`;

describe("findPageMarkers", () => {
  it("reads the Dutch official footer", () => {
    expect(findPageMarkers(foot(3))).toContainEqual({ page: 3, total: 6 });
  });

  it("reads the other spellings", () => {
    expect(findPageMarkers("Pagina 2 van 4")).toContainEqual({ page: 2, total: 4 });
    expect(findPageMarkers("Page 2 of 4")).toContainEqual({ page: 2, total: 4 });
    expect(findPageMarkers("blad 2 van 4")).toContainEqual({ page: 2, total: 4 });
    expect(findPageMarkers("2/4")).toContainEqual({ page: 2, total: 4 });
  });

  it("never reads a page number out of a date or an amount", () => {
    expect(findPageMarkers("8 mei 2026")).toEqual([]);
    expect(findPageMarkers("€ 2.905,00")).toEqual([]);
    expect(findPageMarkers("28-04-2026")).toEqual([]);
    expect(findPageMarkers("BSN 1933.10.107")).toEqual([]);
  });
});

describe("detectPageOrder", () => {
  it("puts the real letter back in order", () => {
    // Measured: the six sheets came off the feeder as 1,2,5,6,3,4.
    const order = detectPageOrder([1, 2, 5, 6, 3, 4].map(foot));
    expect(order).toEqual([0, 1, 4, 5, 2, 3]);
  });

  it("returns null when the pages are already in order", () => {
    expect(detectPageOrder([1, 2, 3, 4, 5, 6].map(foot))).toBeNull();
  });

  it("refuses when a page carries no marker", () => {
    const texts = [1, 2, 5, 6, 3, 4].map(foot);
    texts[2] = "een pagina zonder nummer";
    expect(detectPageOrder(texts)).toBeNull();
  });

  // A letter scanned without its last sheet says "van 6" on five pages.
  // Reordering five pages as if they were six would invent a document.
  it("refuses when the claimed total is not the real page count", () => {
    expect(detectPageOrder([1, 2, 5, 6, 3].map(foot))).toBeNull();
  });

  it("refuses when two sheets claim the same page", () => {
    expect(detectPageOrder([1, 2, 3, 3, 5, 6].map(foot))).toBeNull();
  });

  it("leaves a single page alone", () => {
    expect(detectPageOrder([foot(1)])).toBeNull();
  });

  // The reference number sits in the same footer as the page marker.
  it("is not fooled by a reference number that looks like one", () => {
    const texts = [1, 2, 5, 6, 3, 4].map((n) =>
      `INL230-07 / V013 ref 12/99 Paginanummer ${n} van 6`);
    expect(detectPageOrder(texts)).toEqual([0, 1, 4, 5, 2, 3]);
  });
});
