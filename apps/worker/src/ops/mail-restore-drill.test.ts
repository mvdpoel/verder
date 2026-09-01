import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  collectFacts, countMessages, judgeDrill, mailboxTotals, openDrillSession,
  parseManifest, parseSampleCount, parseTier2, rawSha256, sampleIds, samplePositions,
  assertDistinctApiUrls, shellFailureFrom, withinTier2Tolerance,
  type DrillFacts,
} from "./mail-restore-drill";

// NO DATABASE AND NO NETWORK IN THIS FILE, deliberately. Every other ops test in
// this package talks to the shared dev postgres, and this one has nothing to say
// to it: judgeDrill is pure, and the four JMAP helpers take an injected fetch.
// The drill itself is the integration test — it runs against a server that was
// restored from a real archive — so a DB test here would only contend with the
// suite for a fixture it does not need.

// --- fixtures -----------------------------------------------------------------

/** A DrillFacts that PASSES, so every test below is one deliberate mutation of a
 *  known-good run and the red says which rule caught it. */
function passing(over: Partial<DrillFacts> = {}): DrillFacts {
  return {
    archive: "native-2026-09-01.tar.zst",
    restored: { total: 146270, mailboxes: { Inbox: 137503, Archive: 5544 } },
    expected: {
      total: 146270, mailboxes: { Inbox: 137503, Archive: 5544 }, source: "manifest",
    },
    requestedSamples: 2,
    samples: [
      { id: "eaaaaab", bytes: 52453, restoredSha: "aa", liveSha: "aa" },
      { id: "maaaaad", bytes: 1024, restoredSha: "bb", liveSha: "bb" },
    ],
    sampleFailures: [],
    tier2: { archive: "archive-2026-W36.sqlite.zst", emails: 146270 },
    jmap: { session: true, query: true, get: true },
    ...over,
  };
}

describe("judgeDrill", () => {
  it("passes a restore whose counts, mailboxes, bytes and tier-2 archive all agree", () => {
    expect(judgeDrill(passing())).toEqual({ ok: true, reasons: [] });
  });

  /*
   * RULE 1. "JMAP answers" is deliberately session + query + get and NOT a
   * search — see the comment on the check itself.
   */
  it("fails when the restored server cannot be talked to at all", () => {
    const r = judgeDrill(passing({ jmap: { session: false, query: false, get: false } }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/session/);
  });

  it("fails when Email/get is the one thing that does not answer", () => {
    const r = judgeDrill(passing({ jmap: { session: true, query: true, get: false } }));
    expect(r.ok).toBe(false);
    // Names the half that failed, not merely "JMAP failed": the three probes
    // fail for different reasons and the push body is all the operator gets.
    expect(r.reasons.join("\n")).toMatch(/get/);
    expect(r.reasons.join("\n")).not.toMatch(/query/);
  });

  /*
   * RULE 2. The headline failure a drill exists for: an archive that restores
   * into a store holding less than it was taken from.
   */
  it("fails a short restore and names both figures", () => {
    const r = judgeDrill(passing({
      restored: { total: 140000, mailboxes: { Inbox: 137503, Archive: 5544 } },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toContain("140000");
    expect(r.reasons.join("\n")).toContain("146270");
  });

  /*
   * RULE 3, AND THE REASON IT EXISTS. A bare total cannot tell "146 270
   * messages" from "146 270 messages in the wrong mailboxes", and Mailbox/get
   * hands the per-mailbox figures over in one round trip.
   */
  it("fails when the total matches but a mailbox count does not", () => {
    const r = judgeDrill(passing({
      // 137 503 + 5 544 unchanged as a sum; 200 messages moved from Inbox to
      // Archive. Rule 2 is satisfied and only rule 3 can see this.
      restored: { total: 146270, mailboxes: { Inbox: 137303, Archive: 5744 } },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/Inbox/);
  });

  it("fails when a mailbox the snapshot had is missing from the restore", () => {
    const r = judgeDrill(passing({
      restored: { total: 146270, mailboxes: { Inbox: 137503 } },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/Archive/);
  });

  it("fails when the restore carries a mailbox the snapshot never had", () => {
    const r = judgeDrill(passing({
      restored: {
        total: 146270,
        mailboxes: { Inbox: 137503, Archive: 5544, "Bootstrap Inbox": 0 },
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/Bootstrap Inbox/);
  });

  /*
   * A mailbox named after something on Object.prototype. Far-fetched as mail,
   * ordinary as JSON: `expected.mailboxes` is parsed straight out of the
   * snapshot manifest, and `"constructor" in obj` is true for every object
   * alive. An `in` test would have called this one present and equal.
   */
  it("does not mistake a mailbox named after an Object property for a match", () => {
    const r = judgeDrill(passing({
      restored: { total: 146270, mailboxes: { Inbox: 137503, Archive: 5544 } },
      expected: {
        total: 146270, source: "manifest",
        mailboxes: { Inbox: 137503, Archive: 5544, constructor: 7 },
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/constructor/);
  });

  it("does not let an Object property name hide an unexpected mailbox either", () => {
    // The mirror of the case above, and the one an `in` test gets wrong in the
    // dangerous direction: `"toString" in expected.mailboxes` is true, so a
    // mailbox by that name in the RESTORE would be waved through as expected.
    const r = judgeDrill(passing({
      restored: { total: 146270, mailboxes: { Inbox: 137503, Archive: 5544, toString: 3 } },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/toString/);
  });

  /*
   * RULE 3'S FLOOR, and it is rule 4's floor one rule up. Both comparison loops
   * are over maps that can arrive EMPTY from two independent directions — a
   * restored `Mailbox/get` that threw leaves `{}`, and a manifest can carry
   * `"mailboxes":{}` — and with both empty they iterate zero times and the rule
   * PASSES while the report still claims a per-mailbox comparison happened.
   */
  it("fails rather than passing vacuously when neither side has any mailboxes", () => {
    const r = judgeDrill(passing({
      restored: { total: 146270, mailboxes: {} },
      expected: { total: 146270, mailboxes: {}, source: "manifest" },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/no per-mailbox comparison/);
  });

  it("fails when the restored server produced no mailbox list at all", () => {
    // What a Mailbox/get that threw looks like in the facts: counts fine,
    // mailboxes empty, and NOTHING else in the judgement would have noticed.
    const r = judgeDrill(passing({ restored: { total: 146270, mailboxes: {} } }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/0 in the restore/);
  });

  /*
   * RULE 4. The counts can agree to the message while the bytes are wrong —
   * that is the whole reason a drill downloads anything at all.
   */
  it("fails when a sampled message's bytes differ between the restore and live", () => {
    const r = judgeDrill(passing({
      sampleFailures: ["eaaaaab: restored sha aa != live sha zz"],
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toContain("eaaaaab");
  });

  /*
   * AN EMPTY SAMPLE LIST IS A FAILURE. "We compared nothing and found nothing
   * wrong" is how a check quietly stops checking — the same lesson
   * `strandedOnSpine` and the tier-1 archive listing already carry.
   */
  it("fails when nothing was sampled at all", () => {
    const r = judgeDrill(passing({ samples: [], sampleFailures: [] }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/sampled/i);
  });

  /*
   * RULE 5. The spec (2026-08-29-mail-architecture-design.md §2) requires that
   * there is never a generation where only the native form is proven, so a
   * missing tier-2 report and a skipped one are both failures.
   */
  it("fails when the shell reported nothing at all about tier 2", () => {
    const r = judgeDrill(passing({ tier2: null }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/tier.?2/i);
  });

  it("fails a skipped tier 2 and repeats the shell's own reason", () => {
    const r = judgeDrill(passing({ tier2: { skipped: "no archive for this week yet" } }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toContain("no archive for this week yet");
  });

  it("fails a tier-2 archive that is far short of the snapshot — a truncated pull", () => {
    const r = judgeDrill(passing({
      tier2: { archive: "archive-2026-W36.sqlite.zst", emails: 100000 },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toContain("100000");
  });

  /*
   * AND NOT ON A WEEK OF MAIL. tier 1 is nightly and tier 2 is WEEKLY, so the
   * two artifacts are up to seven days apart and `f.expected.total` is the
   * tier-1 figure. `!==` was exact only while nothing wrote to the store; the
   * hour phase 2 moves delivery onto Stalwart it would fail EVERY month on a
   * healthy pair — and with `errorActionableMs` on the monthly declaration that
   * red does not age out, so it would stand for the whole month by design.
   */
  it("does not fail a tier-2 archive that is merely a week of mail out of step", () => {
    for (const emails of [146270 + 300, 146270 - 300]) {
      expect(judgeDrill(passing({
        tier2: { archive: "archive-2026-W36.sqlite.zst", emails },
      })).ok).toBe(true);
    }
  });

  it("bounds the tolerance in both directions", () => {
    // 5% of 146 270 is 7 313: far more than a week of one person's mail, far
    // less than what a truncated pull takes away.
    expect(withinTier2Tolerance(146270, 146270)).toBe(true);
    expect(withinTier2Tolerance(146270 - 7313, 146270)).toBe(true);
    expect(withinTier2Tolerance(146270 - 7314, 146270)).toBe(false);
    expect(withinTier2Tolerance(146270 + 7314, 146270)).toBe(false);
    // No percentage of nothing: an expected total of 0 admits only equality.
    expect(withinTier2Tolerance(1, 0)).toBe(false);
  });

  it("fails a tier-2 archive that inspects as empty", () => {
    const r = judgeDrill(passing({
      tier2: { archive: "archive-2026-W36.sqlite.zst", emails: 0 },
      // …even where the snapshot itself is empty, which would otherwise make
      // 0 === 0 read as agreement between two things that both hold nothing.
      restored: { total: 0, mailboxes: {} },
      expected: { total: 0, mailboxes: {}, source: "manifest" },
      samples: [{ id: "x", bytes: 1, restoredSha: "a", liveSha: "a" }],
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/tier.?2/i);
  });

  it("reports every broken rule at once rather than the first", () => {
    const r = judgeDrill(passing({
      restored: { total: 1, mailboxes: {} },
      samples: [],
      tier2: null,
      jmap: { session: true, query: true, get: false },
    }));
    // One line per failed rule is what the push body is built from, and an
    // operator woken at 04:00 gets to read the whole diagnosis in one go.
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

// --- a fake JMAP server -------------------------------------------------------

const MAIL = "urn:ietf:params:jmap:mail";

interface FakeStore {
  base: string;
  /** Ids in `Email/query` order — index IS the position. */
  ids: string[];
  mailboxes: { name: string; totalEmails: number }[];
  /** id -> the raw RFC822 bytes `download` hands back. */
  raw: Record<string, string>;
}

/** Every method-call object the fake was sent, so a test can assert what was
 *  NOT in the request — which is how the no-filter rule is pinned. */
const sent: { name: string; args: Record<string, unknown> }[] = [];

function fakeFetch(...stores: FakeStore[]): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const store = stores.find((s) => u.startsWith(s.base));
    if (!store) throw new Error(`fake fetch: no store for ${u}`);

    if (u.endsWith("/.well-known/jmap")) {
      return new Response(JSON.stringify({
        apiUrl: `${store.base}/jmap/`,
        downloadUrl: `${store.base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        primaryAccounts: { [MAIL]: "c" },
      }), { status: 200 });
    }

    const download = /\/jmap\/download\/c\/blob-([^/]+)\//.exec(u);
    if (download) {
      const id = decodeURIComponent(download[1]);
      const body = store.raw[id];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(Buffer.from(body), { status: 200 });
    }

    const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, callId]) => {
      sent.push({ name, args });
      if (name === "Email/query") {
        const position = Number(args.position ?? 0);
        const limit = Number(args.limit ?? 50);
        return [name, {
          ids: store.ids.slice(position, position + limit),
          position,
          ...(args.calculateTotal === true ? { total: store.ids.length } : {}),
        }, callId];
      }
      if (name === "Mailbox/get") {
        return [name, {
          list: store.mailboxes.map((m, i) => ({ id: `mb-${i}`, ...m })),
        }, callId];
      }
      if (name === "Email/get") {
        const ids = (args.ids ?? []) as string[];
        return [name, {
          list: ids.filter((id) => id in store.raw).map((id) => ({ id, blobId: `blob-${id}` })),
          notFound: ids.filter((id) => !(id in store.raw)),
        }, callId];
      }
      return ["error", { type: "unknownMethod" }, callId];
    });
    return new Response(JSON.stringify({ methodResponses }), { status: 200 });
  }) as unknown as typeof fetch;
}

const PROD: FakeStore = {
  base: "http://stalwart:8080",
  ids: Array.from({ length: 146270 }, (_, i) => `id-${i}`),
  mailboxes: [{ name: "Inbox", totalEmails: 137503 }, { name: "Archive", totalEmails: 8767 }],
  raw: {},
};

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

async function session(store: FakeStore, f: typeof fetch) {
  return openDrillSession(store.base, { authorization: "Basic x" }, f);
}

describe("the JMAP probes", () => {
  it("reads the api url and the mail account off the restored server's own session", async () => {
    const f = fakeFetch(PROD);
    const s = await session(PROD, f);
    expect(s.apiUrl).toBe("http://stalwart:8080/jmap/");
    expect(s.accountId).toBe("c");
  });

  /*
   * THE RULE MOST LIKELY TO BE "FIXED" LATER, so it is pinned as an assertion
   * about the request body and not only as a comment. Email/query FILTERS
   * RETURN NOTHING on this store — measured in PRODUCTION, not only in a
   * restore — so a drill that filtered would fail every month on a defect that
   * has nothing to do with the backup.
   */
  it("counts the whole store with no filter whatsoever", async () => {
    sent.length = 0;
    const f = fakeFetch(PROD);
    const total = await countMessages(await session(PROD, f), { authorization: "Basic x" }, f);
    expect(total).toBe(146270);
    const queries = sent.filter((c) => c.name === "Email/query");
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(Object.keys(q.args)).not.toContain("filter");
  });

  it("asks for the total rather than counting the ids it was handed", async () => {
    sent.length = 0;
    const f = fakeFetch(PROD);
    await countMessages(await session(PROD, f), { authorization: "Basic x" }, f);
    const [q] = sent.filter((c) => c.name === "Email/query");
    expect(q.args.calculateTotal).toBe(true);
    // A page of one: the count comes from `total`, and pulling 146 270 ids
    // through the wire to length them would be a different (and much slower)
    // question with the same answer.
    expect(q.args.limit).toBe(1);
  });

  /*
   * A server that IGNORES calculateTotal answers a page and no total, and the
   * obvious fallback — the length of the ids it sent — is `limit`, i.e. 1. That
   * is not a smaller count, it is a made-up one, and rule 2 would then report
   * "the restore holds 1 message" for a store that answered the question wrong.
   * Refusing says which of the two actually happened.
   */
  it("refuses to infer a count from a page when the server sends no total", async () => {
    const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/.well-known/jmap")) {
        return new Response(JSON.stringify({
          apiUrl: "http://x/jmap/", downloadUrl: "", primaryAccounts: { [MAIL]: "c" },
        }), { status: 200 });
      }
      void init;
      return new Response(JSON.stringify({
        methodResponses: [["Email/query", { ids: ["id-0"], position: 0 }, "c0"]],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await openDrillSession("http://x", { authorization: "Basic x" }, f);
    await expect(countMessages(s, { authorization: "Basic x" }, f))
      .rejects.toThrow(/total/);
  });

  it("reads per-mailbox totals in one round trip, in the spelling that was measured", async () => {
    sent.length = 0;
    const f = fakeFetch(PROD);
    const totals = await mailboxTotals(await session(PROD, f), { authorization: "Basic x" }, f);
    expect(totals).toEqual({ Inbox: 137503, Archive: 8767 });
    const [m] = sent.filter((c) => c.name === "Mailbox/get");
    // The 2026-09-01 probe against production sent exactly this and got all 21
    // mailboxes back. `ids: null` is RFC 8620 §5.1's equivalent and would very
    // probably work too — but this function is on two paths whose failure is
    // quiet and monthly, so it sends what was actually asked of this server.
    expect(Object.keys(m.args).sort()).toEqual(["accountId", "properties"]);
    expect(m.args.properties).toEqual(["name", "totalEmails"]);
  });

  /*
   * Two mailboxes may carry the same name (different parents, JMAP has no
   * uniqueness rule on `name`). Keeping the last silently loses the other's
   * messages from the comparison, which is a count that disagrees with the
   * store while reading as agreement.
   */
  it("sums two mailboxes that share a name rather than keeping the last", async () => {
    const twins: FakeStore = {
      ...PROD,
      mailboxes: [
        { name: "Archive", totalEmails: 5544 },
        { name: "Inbox", totalEmails: 137503 },
        { name: "Archive", totalEmails: 3223 },
      ],
    };
    const f = fakeFetch(twins);
    const totals = await mailboxTotals(await session(twins, f), { authorization: "Basic x" }, f);
    expect(totals.Archive).toBe(5544 + 3223);
  });

  /*
   * THE TAIL IS SAMPLED, and the version before this one did not sample it.
   * floor(i × total / n) for i in 0…n−1 tops out at floor(7 × 146270 / 8) =
   * 127 986, so the NEWEST ~18 000 MESSAGES were outside every sample — and a
   * truncated tar or a half-copied blob directory damages exactly the tail. The
   * old test asserted that list and locked the hole in.
   */
  it("samples the first and the last message and spaces the rest evenly", () => {
    expect(samplePositions(146270, 8))
      .toEqual([0, 20895, 41791, 62686, 83582, 104477, 125373, 146269]);
    // The last position is the last message, at every count.
    for (const n of [2, 3, 5, 8, 13, 40]) {
      const ps = samplePositions(146270, n);
      expect(ps).toHaveLength(n);
      expect(ps[0]).toBe(0);
      expect(ps[ps.length - 1]).toBe(146269);
      // Ascending, so a position is never asked for twice out of order.
      expect([...ps].sort((a, b) => a - b)).toEqual(ps);
    }
    // One sample has no interval to divide and must not divide by zero.
    expect(samplePositions(146270, 1)).toEqual([0]);
    expect(samplePositions(0, 8)).toEqual([]);
    expect(samplePositions(146270, 0)).toEqual([]);
  });

  it("asks the server for exactly those positions, unfiltered", async () => {
    sent.length = 0;
    const f = fakeFetch(PROD);
    const got = await sampleIds(await session(PROD, f), { authorization: "Basic x" }, 146270, 8, f);
    const positions = sent.filter((c) => c.name === "Email/query").map((c) => c.args.position);
    expect(positions).toEqual(samplePositions(146270, 8));
    expect(got.ids).toEqual(positions.map((p) => `id-${p}`));
    expect(got.missed).toEqual([]);
    for (const q of sent.filter((c) => c.name === "Email/query")) {
      expect(Object.keys(q.args)).not.toContain("filter");
    }
  });

  it("returns each id once when the store is smaller than the sample count", async () => {
    const tiny: FakeStore = { ...PROD, ids: ["a", "b", "c"] };
    const f = fakeFetch(tiny);
    const got = await sampleIds(await session(tiny, f), { authorization: "Basic x" }, 3, 8, f);
    expect(got.ids).toEqual(["a", "b", "c"]);
    // Deduplication is NOT a miss: those positions were answered, by a message
    // that had already been sampled.
    expect(got.missed).toEqual([]);
  });

  /*
   * A POSITION THAT ANSWERS NOTHING IS REPORTED. It used to be skipped, and a
   * restored store whose index answered one of eight positions then produced one
   * sample, no failures, and a pass that read exactly like a full eight-of-eight
   * comparison.
   */
  it("reports a position the server enumerates nothing at", async () => {
    const holed: FakeStore = { ...PROD, ids: ["a", "b", "c", "d"] };
    const f = fakeFetch(holed);
    // The store answers four positions; ask for positions in a store the caller
    // believes is twice as big, so the back half falls off the end.
    const got = await sampleIds(await session(holed, f), { authorization: "Basic x" }, 8, 4, f);
    expect(got.ids).toEqual(["a", "c"]);
    expect(got.missed).toEqual([4, 7]);
  });

  it("hashes the bytes the download actually returned", async () => {
    const store: FakeStore = { ...PROD, raw: { "id-7": "From: a@b\r\n\r\nhello" } };
    const f = fakeFetch(store);
    const got = await rawSha256(await session(store, f), { authorization: "Basic x" }, "id-7", f);
    expect(got.sha).toBe(sha("From: a@b\r\n\r\nhello"));
    expect(got.bytes).toBe(Buffer.byteLength("From: a@b\r\n\r\nhello"));
  });

  it("refuses a message the restored store cannot produce a blob for", async () => {
    const f = fakeFetch(PROD);
    await expect(rawSha256(await session(PROD, f), { authorization: "Basic x" }, "gone", f))
      .rejects.toThrow(/gone/);
  });
});

// --- the walk -----------------------------------------------------------------

function pair(over: { restoredRaw?: Record<string, string> } = {}) {
  const ids = Array.from({ length: 16 }, (_, i) => `id-${i}`);
  const raw = Object.fromEntries(ids.map((id) => [id, `raw bytes of ${id}`]));
  const live: FakeStore = {
    base: "http://stalwart:8080", ids,
    mailboxes: [{ name: "Inbox", totalEmails: 12 }, { name: "Archive", totalEmails: 4 }],
    raw,
  };
  const restored: FakeStore = {
    ...live, base: "http://stalwart-drill:8080", raw: over.restoredRaw ?? raw,
  };
  return { live, restored, f: fakeFetch(live, restored) };
}

describe("collectFacts", () => {
  it("compares the restore against live when there is no manifest", async () => {
    const { live, restored, f } = pair();
    const facts = await collectFacts({
      restoredBase: restored.base, liveBase: live.base,
      auth: { authorization: "Basic x" }, fetchFn: f,
      archive: "native-2026-09-01.tar.zst", samples: 4, manifest: null,
      tier2: { archive: "archive-2026-W36.sqlite.zst", emails: 16 },
    });
    expect(facts.expected.source).toBe("live");
    expect(facts.restored.total).toBe(16);
    expect(facts.expected.total).toBe(16);
    expect(facts.samples.length).toBe(4);
    expect(facts.requestedSamples).toBe(4);
    expect(facts.sampleFailures).toEqual([]);
    expect(facts.jmap).toEqual({ session: true, query: true, get: true });
    expect(judgeDrill(facts).ok).toBe(true);
  });

  it("prefers the manifest's own counts over live and says so", async () => {
    const { live, restored, f } = pair();
    const facts = await collectFacts({
      restoredBase: restored.base, liveBase: live.base,
      auth: { authorization: "Basic x" }, fetchFn: f,
      archive: "native-2026-09-01.tar.zst", samples: 2,
      manifest: { count: 16, mailboxes: { Inbox: 12, Archive: 4 } },
      tier2: { archive: "a", emails: 16 },
    });
    expect(facts.expected.source).toBe("manifest");
    expect(judgeDrill(facts).ok).toBe(true);
  });

  /*
   * THE FAILURE THE WHOLE DRILL EXISTS FOR: the counts agree to the message and
   * the bytes do not.
   */
  it("catches a restored message whose bytes differ from live", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `id-${i}`);
    const corrupted = Object.fromEntries(ids.map((id) =>
      [id, id === "id-0" ? "CORRUPTED" : `raw bytes of ${id}`]));
    const { live, restored, f } = pair({ restoredRaw: corrupted });
    const facts = await collectFacts({
      restoredBase: restored.base, liveBase: live.base,
      auth: { authorization: "Basic x" }, fetchFn: f,
      archive: "native-2026-09-01.tar.zst", samples: 4, manifest: null,
      tier2: { archive: "a", emails: 16 },
    });
    expect(facts.restored.total).toBe(16);
    expect(facts.sampleFailures.length).toBe(1);
    expect(facts.sampleFailures[0]).toContain("id-0");
    expect(judgeDrill(facts).ok).toBe(false);
  });

  /*
   * A DRILL THAT COMPARED 1 OF THE 8 IT ASKED FOR MUST NOT PASS LIKE ONE THAT
   * COMPARED 8. `sampleIds` used to skip a position the server answered with
   * nothing, so seven silently unanswered positions produced one sample, an
   * empty failure list, and a clean pass — with nothing in `worker_runs.detail`
   * to tell the two apart afterwards. This is the store that does it: it counts
   * 16 messages and then enumerates only the first four, which is what a store
   * with an intact index and a half-copied blob directory looks like from here.
   */
  it("fails when the restored store enumerates nothing at most of the positions", async () => {
    const { live, restored, f } = pair();
    const halfBlind = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await f(url, init);
      // Method calls only — a download carries no body and would not parse.
      if (!String(url).startsWith(restored.base) || !init?.body) return res;
      const body = JSON.parse(String(init.body)) as
        { methodCalls: [string, Record<string, unknown>, string][] };
      const positional = body.methodCalls.some(
        ([name, args]) => name === "Email/query" && Number(args.position ?? 0) >= 4);
      if (!positional) return res;
      const parsed = await res.json() as { methodResponses: [string, Record<string, unknown>, string][] };
      return new Response(JSON.stringify({
        methodResponses: parsed.methodResponses.map(([n, a, c]) =>
          (n === "Email/query" ? [n, { ids: [], position: a.position }, c] : [n, a, c])),
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const facts = await collectFacts({
      restoredBase: restored.base, liveBase: live.base,
      auth: { authorization: "Basic x" }, fetchFn: halfBlind,
      archive: "native-2026-09-01.tar.zst", samples: 4, manifest: null,
      tier2: { archive: "a", emails: 16 },
    });
    // Counts and mailboxes all agree — nothing else in the judgement can see
    // this. Positions 5, 10 and 15 answered nothing and are named as failures.
    expect(facts.restored.total).toBe(16);
    expect(facts.requestedSamples).toBe(4);
    expect(facts.samples.length).toBe(1);
    expect(facts.sampleFailures).toHaveLength(3);
    expect(facts.sampleFailures.join("\n")).toMatch(/position 15/);
    expect(judgeDrill(facts).ok).toBe(false);
  });

  it("records every requested position, so a partial comparison is visible after the fact",
    async () => {
      const { live, restored, f } = pair();
      const facts = await collectFacts({
        restoredBase: restored.base, liveBase: live.base,
        auth: { authorization: "Basic x" }, fetchFn: f,
        archive: "native-2026-09-01.tar.zst", samples: 8, manifest: null,
        tier2: { archive: "a", emails: 16 },
      });
      // 16 messages, 8 positions, all answered: eight compared and the
      // denominator recorded beside them.
      expect(facts.samples.length).toBe(8);
      expect(facts.requestedSamples).toBe(8);
    });
});

/*
 * THE FAILURE THAT LOOKS EXACTLY LIKE SUCCESS. STALWART_PUBLIC_URL decides the
 * session's apiUrl verbatim, so a scratch container that inherits production's
 * value answers discovery with production's api url and every probe after that
 * runs against the LIVE server: identical totals, identical bytes, green
 * forever, proving nothing about any archive. Two different base URLs are not
 * enough to catch it — only the api url the sessions resolved to is.
 */
describe("the same-server guard", () => {
  it("passes two sessions that resolved to different api urls", () => {
    expect(() => assertDistinctApiUrls(
      { apiUrl: "http://stalwart-drill:8080/jmap/", downloadUrl: "", accountId: "c" },
      { apiUrl: "http://stalwart:8080/jmap/", downloadUrl: "", accountId: "c" },
    )).not.toThrow();
  });

  it("refuses to compare a store with itself", () => {
    expect(() => assertDistinctApiUrls(
      { apiUrl: "http://stalwart:8080/jmap/", downloadUrl: "", accountId: "c" },
      { apiUrl: "http://stalwart:8080/jmap/", downloadUrl: "", accountId: "c" },
    )).toThrow(/STALWART_PUBLIC_URL/);
  });

  it("refuses the whole drill when the scratch server hands back production's url", async () => {
    // The scratch server answers on its own base and advertises production's
    // api url in its session — precisely what a forgotten override does.
    const ids = ["a", "b"];
    const live: FakeStore = {
      base: "http://stalwart:8080", ids,
      mailboxes: [{ name: "Inbox", totalEmails: 2 }], raw: { a: "x", b: "y" },
    };
    const inner = fakeFetch(live);
    const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "http://stalwart-drill:8080/.well-known/jmap") {
        return new Response(JSON.stringify({
          apiUrl: "http://stalwart:8080/jmap/",
          downloadUrl: "http://stalwart:8080/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
          primaryAccounts: { [MAIL]: "c" },
        }), { status: 200 });
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    await expect(collectFacts({
      restoredBase: "http://stalwart-drill:8080", liveBase: live.base,
      auth: { authorization: "Basic x" }, fetchFn: f,
      archive: "native-2026-09-01.tar.zst", samples: 2, manifest: null,
      tier2: { archive: "a", emails: 2 },
    })).rejects.toThrow(/STALWART_PUBLIC_URL/);
  });
});

// --- the environment the shell hands over -------------------------------------

describe("parseSampleCount", () => {
  it("defaults to 8 for absent AND for empty", () => {
    // `??` does not fire on "", and an env var is empty far more often than it
    // is absent — the trap parseFirstSyncPages already records.
    expect(parseSampleCount(undefined)).toBe(8);
    expect(parseSampleCount("")).toBe(8);
    expect(parseSampleCount("  ")).toBe(8);
  });

  it("takes a positive whole number", () => {
    expect(parseSampleCount("32")).toBe(32);
  });

  it("refuses anything that is not one rather than coercing it", () => {
    for (const bad of ["0", "-4", "1.5", "8e1", "eight"]) {
      expect(() => parseSampleCount(bad)).toThrow(/MAIL_DRILL_SAMPLES/);
    }
  });
});

describe("parseTier2", () => {
  it("reports nothing at all as null, which judgeDrill fails", () => {
    expect(parseTier2(undefined)).toBeNull();
    expect(parseTier2("")).toBeNull();
    expect(judgeDrill(passing({ tier2: parseTier2(undefined) })).ok).toBe(false);
  });

  it("carries the inspected count through", () => {
    expect(parseTier2('{"archive":"archive-2026-W36.sqlite.zst","emails":146270}'))
      .toEqual({ archive: "archive-2026-W36.sqlite.zst", emails: 146270 });
  });

  it("carries a skip reason through verbatim", () => {
    expect(parseTier2('{"skipped":"vandelay inspect is not installed"}'))
      .toEqual({ skipped: "vandelay inspect is not installed" });
  });

  /*
   * Malformed input becomes a SKIP, not a throw and not a pass: a skip is a
   * failure with a reason attached, so a shell that garbles its own report
   * fails the drill and says exactly that, rather than crashing before the
   * worker_runs row is written.
   */
  it("turns unreadable JSON into a skip that names itself", () => {
    const t = parseTier2("{not json");
    expect(t).not.toBeNull();
    expect(t && "skipped" in t && t.skipped).toMatch(/MAIL_DRILL_TIER2/);
    expect(judgeDrill(passing({ tier2: t })).ok).toBe(false);
  });

  it("turns a well-formed object with the wrong shape into a skip", () => {
    const t = parseTier2('{"archive":"a","emails":"lots"}');
    expect(t && "skipped" in t).toBe(true);
  });
});

describe("parseManifest", () => {
  it("reads the count and the per-mailbox totals the snapshot recorded", () => {
    expect(parseManifest('{"count":146270,"takenAt":"2026-09-01T03:30:00Z",'
      + '"mailboxes":{"Inbox":137503}}'))
      .toEqual({ count: 146270, mailboxes: { Inbox: 137503 } });
  });

  it("refuses a manifest with no mailbox totals rather than comparing against none", () => {
    // An empty `expected.mailboxes` would make EVERY restored mailbox an
    // unexpected one, so rule 3 would fail 21 times over on a healthy restore.
    // Refusing sends main() to the live fallback, which is exact in phase 1.
    expect(() => parseManifest('{"count":146270}')).toThrow();
    // AND `{}`, which is the shape that is actually reachable: mail-backup.sh's
    // structural gate only checks that the key opens a brace. The guard used to
    // test presence alone, so this passed and produced exactly the empty
    // `expected.mailboxes` the comment above it says must never reach the judge.
    expect(() => parseManifest('{"count":146270,"mailboxes":{}}')).toThrow(/no mailbox totals/);
  });

  it("refuses a manifest whose counts are not numbers", () => {
    expect(() => parseManifest('{"count":"146270","mailboxes":{"Inbox":1}}')).toThrow();
    expect(() => parseManifest('{"count":1,"mailboxes":{"Inbox":"137503"}}')).toThrow();
  });
});

/*
 * THE SHELL'S OWN FAILURES. Eight paths in ops/mail-restore-drill.sh exit before
 * this script is started at all, and two of them ARE the drill's headline result
 * ("the archive cannot restore"). They used to record nothing: no worker_runs
 * row, no push, and the dashboard's `DISTINCT ON (worker)` kept showing last
 * month's `ok` for another 35 days. The shell now hands the reason back here so
 * one writer owns the row.
 */
describe("shellFailureFrom", () => {
  it("reads a reason the shell handed over", () => {
    expect(shellFailureFrom({ MAIL_DRILL_SHELL_FAILURE: "no archive to restore from" }))
      .toBe("no archive to restore from");
  });

  it("treats absent and empty alike, so an ordinary run is never mistaken for one", () => {
    // `??` does not fire on "", and an env var is empty far more often than it
    // is absent — a `-e NAME` for a variable the caller never set is exactly
    // that. An empty value must mean "the drill ran normally", or every
    // scheduled run would record a blank failure instead of a verdict.
    expect(shellFailureFrom({})).toBeNull();
    expect(shellFailureFrom({ MAIL_DRILL_SHELL_FAILURE: "" })).toBeNull();
    expect(shellFailureFrom({ MAIL_DRILL_SHELL_FAILURE: "   " })).toBeNull();
  });
});
