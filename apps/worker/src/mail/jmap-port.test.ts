import { describe, expect, it, vi } from "vitest";
import { JmapMethodError } from "./jmap-client";
import {
  DEFAULT_LIMITS, MailMessageUndatableError, isInlineBodyImage, makeJmapPort,
  type MailDateFallback,
} from "./jmap-port";
import { MailCursorRejectedError, MailFirstSyncOverflowError } from "./port";

const S = { apiUrl: "https://x/api", downloadUrl: "d", accountId: "a" };
const CORE = "urn:ietf:params:jmap:core";

/** A session that advertises core limits, which `openSession` does not yet
 *  surface — the port has to read them defensively, so a test builds one. */
function withCaps(core: Record<string, number>): typeof S {
  return { ...S, capabilities: { [CORE]: core } } as unknown as typeof S;
}

/** The injected `call`, typed so a test can read back what was actually sent. */
type CallArgs = [unknown, unknown, string[], unknown[][]];
function fakeCall(responses: (unknown[] | ((calls: unknown[][]) => unknown[]))[]) {
  let n = 0;
  return vi.fn(async (_s: unknown, _t: unknown, _using: string[], calls: unknown[][]) => {
    const r = responses[Math.min(n, responses.length - 1)];
    n++;
    return typeof r === "function" ? r(calls) : r;
  });
}
function sent(call: ReturnType<typeof fakeCall>, i = 0): CallArgs {
  return call.mock.calls[i] as unknown as CallArgs;
}
const port = (call: unknown) =>
  makeJmapPort({ session: S, token: "t", call: call as never, download: vi.fn() as never });

describe("isInlineBodyImage", () => {
  // Same rule as the Gmail port: image/* AND inline AND a cid. macOS Mail marks
  // EVERY attachment inline, so disposition alone would drop a mailed
  // Beschikking.pdf unrecoverably.
  it("skips a cid image the body embeds", () => {
    expect(isInlineBodyImage({ name: "logo.png", type: "image/png", disposition: "inline", cid: "x@y", blobId: "b" })).toBe(true);
  });
  it("keeps an inline PDF, because only images are body furniture", () => {
    expect(isInlineBodyImage({ name: "Beschikking.pdf", type: "application/pdf", disposition: "inline", cid: "x@y", blobId: "b" })).toBe(false);
  });
  it("keeps an image with no cid — a pasted screenshot is a real attachment", () => {
    expect(isInlineBodyImage({ name: "image.png", type: "image/png", disposition: "inline", cid: null, blobId: "b" })).toBe(false);
  });
  it("keeps anything with missing metadata rather than guessing it away", () => {
    expect(isInlineBodyImage({ name: "x", type: null, disposition: null, cid: null, blobId: "b" })).toBe(false);
  });
});

describe("JmapPort.changedSince — first sync (no cursor)", () => {
  // RFC 8620 §5.2 types Email/changes `sinceState` as a REQUIRED String. There
  // is no null form, so a null cursor sent as `sinceState` is answered with
  // invalidArguments — and because writeCursor is never reached, every later
  // poll repeats the identical invalid request forever. Ingestion never starts.
  it("enumerates with Email/query and NEVER sends sinceState", async () => {
    const call = fakeCall([[
      { ids: ["e1", "e2"], total: 2 },
      { state: "s1", list: [{ id: "e1" }, { id: "e2" }] },
    ]]);
    const r = await port(call).changedSince(null);

    expect(r.ids).toEqual(["e1", "e2"]);
    expect(r.cursor).toBe("s1");          // Email/get's state is the canonical one
    expect(r.hasMore).toBe(false);
    const [, , , calls] = sent(call);
    expect(calls.map((c) => c[0])).toEqual(["Email/query", "Email/get"]);
    expect(JSON.stringify(calls)).not.toContain("sinceState");
    expect(JSON.stringify(calls)).not.toContain("Email/changes");
  });

  it("chains query into get with a back-reference, in ONE round trip", async () => {
    const call = fakeCall([[
      { ids: ["e1"], total: 1 },
      { state: "s1", list: [{ id: "e1" }] },
    ]]);
    await port(call).changedSince(null);

    expect(call).toHaveBeenCalledTimes(1);
    const [, , , calls] = sent(call);
    expect((calls[1][1] as Record<string, unknown>)["#ids"])
      .toEqual({ resultOf: "q0", name: "Email/query", path: "/ids" });
    // Never a literal id list beside the back-reference: the two disagree the
    // moment the query pages, and a server may honour either.
    expect((calls[1][1] as Record<string, unknown>).ids).toBeUndefined();
  });

  it("pages the query until a short page ends it, keeping the FIRST state", async () => {
    const page1 = ["a1", "a2"];
    const page2 = ["b1"];
    const call = fakeCall([
      [{ ids: page1 }, { state: "s1", list: page1.map((id) => ({ id })) }],
      [{ ids: page2 }, { state: "s9", list: page2.map((id) => ({ id })) }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 2 },
    });
    const r = await p.changedSince(null);

    expect(r.ids).toEqual(["a1", "a2", "b1"]);
    // The EARLIEST state, so anything that arrived while paging is replayed by
    // the next Email/changes rather than falling between the two.
    expect(r.cursor).toBe("s1");
    expect(r.hasMore).toBe(false);
    expect((sent(call, 1)[3][0][1] as { position: number }).position).toBe(2);
  });

  // A truncated first sync is UNRECOVERABLE in a way a truncated Email/changes
  // is not: the cursor pollMail then writes says "everything before this state
  // is done", and the messages the query never reached are stranded forever.
  it("refuses to return a cursor when the enumeration hits its page bound", async () => {
    const call = fakeCall([[{ ids: ["a", "b"] }, { state: "s1", list: [{ id: "a" }, { id: "b" }] }]]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 2, firstSyncPages: 2 },
    });
    await expect(p.changedSince(null)).rejects.toBeInstanceOf(MailFirstSyncOverflowError);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("first-syncs an empty mailbox to the bare state", async () => {
    const call = fakeCall([[{ ids: [], total: 0 }, { state: "s1", list: [] }]]);
    const r = await port(call).changedSince(null);
    expect(r.ids).toEqual([]);
    expect(r.cursor).toBe("s1");
  });

  // FINDING A. RFC 8620 §5.5: "The server MAY choose to enforce a maximum limit
  // argument. In this case, if a greater value is given (or if it is null), the
  // limit is clamped to the maximum; the new limit is returned with the
  // response so the client is aware." Deciding end-of-mailbox from the limit we
  // ASKED for reads a clamped page as a short page — the walk stops, the
  // overflow guard never fires, and a cursor is written for a PARTIAL
  // enumeration. Everything past the clamp is then neither `created` nor
  // `updated` after that state, so Email/changes never returns it again: it is
  // stranded permanently and silently, on the one run — the 11.49 GB import —
  // where it matters most.
  it("keeps paging when the server CLAMPS the limit it was asked for", async () => {
    const call = fakeCall([
      [{ ids: ["a1", "a2"], limit: 2, total: 3, position: 0 },
        { state: "s1", list: [{ id: "a1" }, { id: "a2" }] }],
      [{ ids: ["b1"], limit: 2, position: 2 }, { state: "s9", list: [{ id: "b1" }] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 500, firstSyncPages: 5 },
    });
    const r = await p.changedSince(null);

    expect(call).toHaveBeenCalledTimes(2);
    expect(r.ids).toEqual(["a1", "a2", "b1"]);
    expect(r.cursor).toBe("s1");
    // Resumed from where the SERVER said the page started, not from a count we
    // kept ourselves.
    expect((sent(call, 1)[3][0][1] as { position: number }).position).toBe(2);
  });

  // The same clamp against the page bound: a walk that is still full at the
  // last page it may take must refuse a cursor exactly as it does when the
  // limit was honoured, or the clamp becomes a way to smuggle a partial
  // enumeration past the guard.
  it("trips the overflow guard on a CLAMPED page that is still full", async () => {
    const call = fakeCall([[{ ids: ["a", "b"], limit: 2 }, { state: "s1", list: [{ id: "a" }, { id: "b" }] }]]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 500, firstSyncPages: 2 },
    });
    await expect(p.changedSince(null)).rejects.toBeInstanceOf(MailFirstSyncOverflowError);
    expect(call).toHaveBeenCalledTimes(2);
  });

  // `total` is asked for on the first page only and may move while we walk, so
  // it can add a page but must never end the walk early. A short page with the
  // total still ahead of us is the shape of a server that answered with less
  // than it was asked for without being at the end of the list.
  it("keeps paging while the reported total is still ahead of the position", async () => {
    const call = fakeCall([
      [{ ids: ["a1"], limit: 4, total: 2, position: 0 }, { state: "s1", list: [{ id: "a1" }] }],
      [{ ids: ["a2"], limit: 4, position: 1 }, { state: "s9", list: [{ id: "a2" }] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 4, firstSyncPages: 5 },
    });
    const r = await p.changedSince(null);

    expect(call).toHaveBeenCalledTimes(2);
    expect(r.ids).toEqual(["a1", "a2"]);
    expect(r.cursor).toBe("s1");
  });

  // FINDING 14. The clamp guard above rests ENTIRELY on the server obeying an
  // RFC MUST. RFC 8620 §5.5 says a clamped `limit` is returned with the
  // response, and `calculateTotal` is asked for on page 0 only — so a server
  // that clamps the page WITHOUT echoing `limit` and answers no `total` makes
  // the very first page look short. The walk ends, the overflow guard never
  // fires, and firstSync returns a cursor meaning "everything up to this state
  // is accounted for" over a PARTIAL enumeration: the same silent, permanent
  // strand the clamp guard exists to prevent, reached through a different door.
  //
  // Nothing the first page carries can tell a silent clamp apart from a small
  // mailbox, so the port stops GUESSING and asks: a short page that the server
  // has neither confirmed (`limit`), accounted for (`total`), nor already
  // contradicted (an earlier page of the size we asked for) is not accepted as
  // the end of the list. The cost is one confirming round trip that must come
  // back empty; the benefit is that a clamping server is enumerated correctly
  // instead of being half-read and declared complete.
  it("keeps paging when the server clamps SILENTLY — no limit, no total", async () => {
    const call = fakeCall([
      [{ ids: ["a1", "a2"] }, { state: "s1", list: [{ id: "a1" }, { id: "a2" }] }],
      [{ ids: ["b1", "b2"] }, { state: "s9", list: [{ id: "b1" }, { id: "b2" }] }],
      [{ ids: [] }, { state: "s9", list: [] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 500, firstSyncPages: 5 },
    });
    const r = await p.changedSince(null);

    expect(call).toHaveBeenCalledTimes(3);
    expect(r.ids).toEqual(["a1", "a2", "b1", "b2"]);
    expect(r.cursor).toBe("s1");
    expect(r.hasMore).toBe(false);
    // Each page resumed from where the previous one ended, so the clamp is
    // walked rather than merely detected.
    expect((sent(call, 1)[3][0][1] as { position: number }).position).toBe(2);
    expect((sent(call, 2)[3][0][1] as { position: number }).position).toBe(4);
  });

  // The other side of the same coin: a genuinely small mailbox on a server that
  // ignores calculateTotal pays for exactly ONE confirming page, and that page
  // coming back empty is what makes the cursor honest.
  it("confirms a short first page with one empty page, and stops there", async () => {
    const call = fakeCall([
      [{ ids: ["a1"] }, { state: "s1", list: [{ id: "a1" }] }],
      [{ ids: [] }, { state: "s9", list: [] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 500, firstSyncPages: 5 },
    });
    const r = await p.changedSince(null);

    expect(call).toHaveBeenCalledTimes(2);
    expect(r.ids).toEqual(["a1"]);
    expect(r.cursor).toBe("s1");
  });

  // And the confirming page is bought ONLY where the shortness is genuinely
  // ambiguous. A server that answered a total has already said how much there
  // is, so paying a round trip to re-ask would be a tax on every first sync.
  it("buys no confirming page when the server stated a total", async () => {
    const call = fakeCall([[{ ids: ["a1"], total: 1 }, { state: "s1", list: [{ id: "a1" }] }]]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 500, firstSyncPages: 5 },
    });
    expect((await p.changedSince(null)).ids).toEqual(["a1"]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  // Nor once the server has demonstrated it will hand back the page size we
  // asked for: from then on a short page can only be the end of the list.
  it("buys no confirming page once a full-size page has been seen", async () => {
    const call = fakeCall([
      [{ ids: ["a1", "a2"] }, { state: "s1", list: [{ id: "a1" }, { id: "a2" }] }],
      [{ ids: ["b1"] }, { state: "s9", list: [{ id: "b1" }] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 2, firstSyncPages: 5 },
    });
    const r = await p.changedSince(null);

    expect(call).toHaveBeenCalledTimes(2);
    expect(r.ids).toEqual(["a1", "a2", "b1"]);
  });

  // FINDING 13, the mirror of finding 12 below. The guard on the first sync's
  // state was `state === null`, which lets an EMPTY STRING through — and an
  // empty string is not a missing cursor. writeCursor omits only a NULL cursor,
  // so `""` is written into worker_runs.detail, read back by readCursor as a
  // string, and sent as `sinceState: ""` on the very next poll: a different
  // spelling of the blocker this round already killed.
  it("refuses an empty-string state as a first-sync cursor", async () => {
    const call = fakeCall([[{ ids: ["a1"], total: 1 }, { state: "", list: [{ id: "a1" }] }]]);
    await expect(port(call).changedSince(null)).rejects.toThrow(/usable state/);
  });

  it("refuses a first sync whose Email/get carried no state at all", async () => {
    const call = fakeCall([[{ ids: ["a1"], total: 1 }, { list: [{ id: "a1" }] }]]);
    await expect(port(call).changedSince(null)).rejects.toThrow(/usable state/);
  });

  // A state from a LATER page is a state the mailbox has already moved past:
  // anything created between page 0 and page 1 is neither enumerated here (that
  // page is behind us) nor replayed by the next Email/changes. So a missing
  // first-page state is refused rather than papered over with page 1's.
  it("never adopts a later page's state when the first page had none", async () => {
    const call = fakeCall([
      [{ ids: ["a1", "a2"] }, { list: [{ id: "a1" }, { id: "a2" }] }],
      [{ ids: ["b1"] }, { state: "s9", list: [{ id: "b1" }] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 2, firstSyncPages: 5 },
    });
    await expect(p.changedSince(null)).rejects.toThrow(/usable state/);
  });

  // A total that outlived the messages it counted (deletions during the walk)
  // must not spin the loop into a false overflow: an empty page is the end of
  // the list whatever the total says.
  it("stops on an empty page even when the stale total claims more", async () => {
    const call = fakeCall([
      [{ ids: ["a1"], limit: 4, total: 9, position: 0 }, { state: "s1", list: [{ id: "a1" }] }],
      [{ ids: [], limit: 4, position: 1 }, { state: "s9", list: [] }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { pageSize: 4, firstSyncPages: 5 },
    });
    const r = await p.changedSince(null);
    expect(r.ids).toEqual(["a1"]);
    expect(r.cursor).toBe("s1");
    expect(r.hasMore).toBe(false);
  });
});

// FINDING D. One `pageSize` knob was spent as three different server-side
// limits while the session's own advertised limits were read and discarded.
describe("JmapPort — the session's advertised core limits", () => {
  // The first sync back-references the query's WHOLE page into Email/get, so
  // the page is bounded by what one Email/get may name: RFC 8620 §5.1 has the
  // server reject an over-long `ids` with requestTooLarge, which would fail
  // every first sync outright.
  it("bounds the first-sync page by maxObjectsInGet", async () => {
    const call = fakeCall([[{ ids: ["a"], limit: 2 }, { state: "s1", list: [{ id: "a" }] }]]);
    const p = makeJmapPort({
      session: withCaps({ maxObjectsInGet: 2 }), token: "t",
      call: call as never, download: vi.fn() as never, limits: { pageSize: 500 },
    });
    await p.changedSince(null);
    expect((sent(call)[3][0][1] as { limit: number }).limit).toBe(2);
  });

  it("asks for the configured page size when the session advertises nothing", async () => {
    const call = fakeCall([[{ ids: [] }, { state: "s1", list: [] }]]);
    await port(call).changedSince(null);
    expect((sent(call)[3][0][1] as { limit: number }).limit).toBe(DEFAULT_LIMITS.pageSize);
  });

  // maxObjectsInGet governs OBJECTS in an Email/get. Email/changes returns id
  // strings and RFC 8620 §5.2 advertises no cap on maxChanges at all, so
  // spending the get limit here would shrink the delta drain for no reason.
  it("does not spend maxObjectsInGet on Email/changes", async () => {
    const call = fakeCall([[{ newState: "s2", created: [], updated: [], destroyed: [] }]]);
    const p = makeJmapPort({
      session: withCaps({ maxObjectsInGet: 2 }), token: "t",
      call: call as never, download: vi.fn() as never, limits: { pageSize: 7 },
    });
    await p.changedSince("s1");
    expect((sent(call)[3][0][1] as { maxChanges: number }).maxChanges).toBe(7);
  });

  // The first sync is two method calls in one request and cannot be expressed
  // in fewer — without the back-reference there is no single round trip whose
  // Email/get state matches the ids it returned. A session that cannot carry
  // two says so up front; sending it anyway earns an opaque server refusal.
  it("refuses a first sync a session of maxCallsInRequest 1 cannot carry", async () => {
    const call = fakeCall([[]]);
    const p = makeJmapPort({
      session: withCaps({ maxCallsInRequest: 1 }), token: "t",
      call: call as never, download: vi.fn() as never,
    });
    await expect(p.changedSince(null)).rejects.toThrow(/maxCallsInRequest/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("JmapPort.changedSince — with a cursor", () => {
  it("returns created and updated ids plus the new cursor", async () => {
    const call = fakeCall([[{
      newState: "s2", created: ["e1"], updated: ["e2"], destroyed: ["e3"] }]]);
    const r = await port(call).changedSince("s1");
    expect(r.ids).toEqual(["e1", "e2"]);   // destroyed is not ingestable
    expect(r.cursor).toBe("s2");
    expect(r.hasMore).toBe(false);
    expect(sent(call)[3][0][0]).toBe("Email/changes");
    expect((sent(call)[3][0][1] as { sinceState: string }).sinceState).toBe("s1");
  });

  // RFC 8620 §5.2: over maxChanges the server answers an INTERMEDIATE newState
  // plus hasMoreChanges, and expects the client to call again. Reading only the
  // first page leaves a run reading {ingested: 500} with thousands still queued
  // and no sign of it anywhere.
  it("drains hasMoreChanges in one poll and merges every page", async () => {
    const call = fakeCall([
      [{ newState: "s2", created: ["e1"], updated: [], destroyed: [], hasMoreChanges: true }],
      [{ newState: "s3", created: ["e2"], updated: ["e1"], destroyed: [], hasMoreChanges: false }],
    ]);
    const r = await port(call).changedSince("s1");

    expect(r.ids).toEqual(["e1", "e2"]);   // e1 seen twice, ingested once
    expect(r.cursor).toBe("s3");
    expect(r.hasMore).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
    // Page 2 resumes from page 1's intermediate state, never from the original.
    expect((sent(call, 1)[3][0][1] as { sinceState: string }).sinceState).toBe("s2");
  });

  it("stops at the page bound and reports the backlog instead of looping", async () => {
    const call = fakeCall([
      [{ newState: "s2", created: ["e1"], updated: [], destroyed: [], hasMoreChanges: true }],
      [{ newState: "s3", created: ["e2"], updated: [], destroyed: [], hasMoreChanges: true }],
      [{ newState: "s4", created: ["e3"], updated: [], destroyed: [], hasMoreChanges: true }],
    ]);
    const p = makeJmapPort({
      session: S, token: "t", call: call as never, download: vi.fn() as never,
      limits: { changesPages: 2 },
    });
    const r = await p.changedSince("s1");

    expect(call).toHaveBeenCalledTimes(2);
    expect(r.ids).toEqual(["e1", "e2"]);
    expect(r.cursor).toBe("s3");   // intermediate, and safe: the next poll resumes
    expect(r.hasMore).toBe(true);
  });

  // FINDING 12. `state = r.newState` accepted whatever arrived. An undefined
  // newState became the returned cursor; writeCursor's `cursor === null` test
  // does not catch undefined, JSON serialisation then DROPS the key entirely,
  // and readCursor answers null — so the next poll silently re-enumerates the
  // WHOLE mailbox as a first sync, with no `resynced` flag and no error
  // anywhere. On an 11.49 GB archive that is not a small thing. An empty string
  // is the same fault wearing the other hat: it survives serialisation and goes
  // back out as `sinceState: ""`.
  it("refuses a delta whose newState the server never sent", async () => {
    const call = fakeCall([[{ created: ["e1"], updated: [], destroyed: [] }]]);
    await expect(port(call).changedSince("s1")).rejects.toThrow(/newState/);
  });

  it("refuses a delta whose newState is an empty string", async () => {
    const call = fakeCall([[{ newState: "", created: ["e1"], updated: [], destroyed: [] }]]);
    await expect(port(call).changedSince("s1")).rejects.toThrow(/newState/);
  });

  // Mid-drain is where it bites hardest: page 1 advanced the state, so a page 2
  // that answers with nothing usable would hand back page 1's ids under a
  // cursor that cannot be written — better to re-ask the whole delta.
  it("refuses an unusable newState part-way through a drain", async () => {
    const call = fakeCall([
      [{ newState: "s2", created: ["e1"], updated: [], destroyed: [], hasMoreChanges: true }],
      [{ created: ["e2"], updated: [], destroyed: [], hasMoreChanges: false }],
    ]);
    await expect(port(call).changedSince("s1")).rejects.toThrow(/newState/);
    expect(call).toHaveBeenCalledTimes(2);
  });

  // cannotCalculateChanges is an EXPECTED JMAP condition — a store rebuild, a
  // long outage, the Vandelay import — and the recovery (drop the cursor, full
  // resync) belongs to the poll layer. It only has to be able to tell it apart
  // from a socket failure, which must NOT drop a valid cursor.
  it("raises MailCursorRejectedError when the server rejects the cursor", async () => {
    const call = vi.fn(async () => {
      throw new JmapMethodError("cannotCalculateChanges", "c0", "state too old");
    });
    const err = await port(call).changedSince("s1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailCursorRejectedError);
    expect((err as MailCursorRejectedError).cursor).toBe("s1");
    expect((err as MailCursorRejectedError).cause).toBeInstanceOf(JmapMethodError);
  });

  it("lets a transport failure through untouched", async () => {
    const call = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const err = await port(call).changedSince("s1").catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(MailCursorRejectedError);
    expect(String(err)).toContain("ECONNRESET");
  });

  it("does not mistake another JMAP method error for a stale cursor", async () => {
    const call = vi.fn(async () => { throw new JmapMethodError("serverFail", "c0"); });
    const err = await port(call).changedSince("s1").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MailCursorRejectedError);
  });
});

describe("JmapPort capabilities", () => {
  // RFC 8620 §3.3: the client advertises every capability it uses, and core
  // governs the request object itself.
  const CAPS = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

  it("advertises core alongside mail on Email/changes", async () => {
    const delta = fakeCall([[{ newState: "s2", created: [], updated: [], destroyed: [] }]]);
    await port(delta).changedSince("s1");
    expect(sent(delta)[2]).toEqual(CAPS);
  });

  it("advertises core alongside mail on the first sync", async () => {
    const first = fakeCall([[{ ids: [] }, { state: "s1", list: [] }]]);
    await port(first).changedSince(null);
    expect(sent(first)[2]).toEqual(CAPS);
  });

  it("advertises core alongside mail on Email/get", async () => {
    const call = fakeCall([[{ list: [{
      id: "e1", threadId: "t1", blobId: "b", subject: "s", receivedAt: "2026-08-24T10:00:00Z",
      from: [], to: [], bodyValues: {}, textBody: [], attachments: [] }] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never, download: vi.fn(async () => Buffer.from("x")) as never });
    await p.getMessage("e1");
    expect(sent(call)[2]).toEqual(CAPS);
  });
});

describe("JmapPort.getMessage", () => {
  const message = (extra: Record<string, unknown>) => ({
    id: "e1", threadId: "t1", blobId: "raw-blob", subject: "Stukken",
    receivedAt: "2026-08-24T10:00:00Z",
    from: [{ email: "case@verdergroep.nl" }], to: [{ email: "martin@vanderpoel.pro" }],
    bodyValues: { "1": { value: "Beste Martin" } },
    textBody: [{ partId: "1" }],
    attachments: [],
    ...extra,
  });

  it("downloads the raw message and every non-inline attachment", async () => {
    const call = fakeCall([[{ list: [message({ attachments: [
      { name: "checklist.pdf", type: "application/pdf", disposition: "attachment", cid: null, blobId: "b1" },
      { name: "logo.png", type: "image/png", disposition: "inline", cid: "c@d", blobId: "b2" },
    ] })] }]]);
    const download = vi.fn(async (_s, _t, blobId) => Buffer.from(`bytes-${blobId}`));
    const p = makeJmapPort({ session: S, token: "t", call: call as never, download: download as never });
    const m = await p.getMessage("e1");

    expect(m.from).toBe("case@verdergroep.nl");
    expect(m.raw.toString()).toBe("bytes-raw-blob");
    expect(m.attachments.map((a) => a.filename)).toEqual(["checklist.pdf"]);
    expect(m.skippedParts?.map((p2) => p2.filename)).toEqual(["logo.png"]);
    expect(m.bodyText).toBe("Beste Martin");
  });

  // receivedAt is when the STORE took delivery — for the Vandelay import that is
  // the import date. sent_at flows into documents.received_at, which is EVIDENCE
  // and append-only, so a wrong date is not correctable later.
  it("dates a message by its Date header, not by when the store received it", async () => {
    const call = fakeCall([[{ list: [message({ sentAt: "2026-04-24T08:30:00Z" })] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never, download: vi.fn(async () => Buffer.from("x")) as never });
    const m = await p.getMessage("e1");

    expect(m.sentAt.toISOString()).toBe("2026-04-24T08:30:00.000Z");
    const props = (sent(call)[3][0][1] as { properties: string[] }).properties;
    expect(props).toContain("sentAt");
  });

  it("falls back to receivedAt when the message carries no Date header", async () => {
    const call = fakeCall([[{ list: [message({ sentAt: null })] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never, download: vi.fn(async () => Buffer.from("x")) as never });
    const m = await p.getMessage("e1");
    expect(m.sentAt.toISOString()).toBe("2026-08-24T10:00:00.000Z");
  });

  // FINDING B. The fallback is the right preference order and leaves no trace.
  // receivedAt is when THIS store took delivery, which for anything Vandelay
  // injects from the Takeout mbox is the IMPORT DATE — a 2024 sommation whose
  // Date header the export dropped lands dated 2026, inside documents.received_at,
  // which is evidence and append-only and cannot be corrected afterwards. The
  // count is how an operator learns the rate of that instead of assuming it.
  const notes = () => {
    const seen: MailDateFallback[] = [];
    return { seen, onDateFallback: (n: MailDateFallback) => seen.push(n) };
  };

  it("reports a message dated by delivery time rather than by its own header", async () => {
    const n = notes();
    const call = fakeCall([[{ list: [message({ sentAt: null })] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never,
      download: vi.fn(async () => Buffer.from("x")) as never, onDateFallback: n.onDateFallback });
    await p.getMessage("e1");

    expect(n.seen).toEqual([
      { id: "e1", reason: "no-date-header", receivedAt: "2026-08-24T10:00:00Z" },
    ]);
  });

  it("reports nothing when the Date header was usable", async () => {
    const n = notes();
    const call = fakeCall([[{ list: [message({ sentAt: "2026-04-24T08:30:00Z" })] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never,
      download: vi.fn(async () => Buffer.from("x")) as never, onDateFallback: n.onDateFallback });
    await p.getMessage("e1");
    expect(n.seen).toEqual([]);
  });

  // FINDING C, the poison pill. `new Date("Tue, 32 Foo 2024")` is an Invalid
  // Date; Drizzle's pg timestamp mapper calls .toISOString() on it and throws
  // RangeError, poll.ts catches that into `failures` and — correctly — HOLDS
  // the cursor. But this failure can never succeed on retry: the same message
  // fails every poll, the cursor never advances, the delta grows without bound
  // and mail ingestion is dead until a human intervenes. A malformed header
  // with a good delivery date is the SAME condition as a missing one, so it
  // takes the same route and is counted the same way.
  it("treats an unparseable Date header as a missing one rather than stalling", async () => {
    const n = notes();
    const call = fakeCall([[{ list: [message({ sentAt: "Tue, 32 Foo 2024 99:99:99" })] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never,
      download: vi.fn(async () => Buffer.from("x")) as never, onDateFallback: n.onDateFallback });
    const m = await p.getMessage("e1");

    expect(m.sentAt.toISOString()).toBe("2026-08-24T10:00:00.000Z");
    expect(n.seen).toEqual([
      { id: "e1", reason: "unparseable-date-header", receivedAt: "2026-08-24T10:00:00Z" },
    ]);
  });

  // Both unusable is a different animal: a server-generated UTCDate that does
  // not parse is a broken STORE, not a broken message, and ingesting a whole
  // mailbox under a date this app invented is the one thing it may never do.
  // So it refuses THIS message, loudly and by name — never with a bare Invalid
  // Date that dies three layers down inside a Drizzle mapper.
  it("refuses a message with no usable date at all, naming it", async () => {
    const call = fakeCall([[{ list: [message({ sentAt: null, receivedAt: "not-a-date" })] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never,
      download: vi.fn(async () => Buffer.from("x")) as never });
    const err = await p.getMessage("e1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailMessageUndatableError);
    expect(String(err)).toContain("e1");
    expect(String(err)).toContain("not-a-date");
  });

  // FINDING E. headers() already reads `r.list ?? []`; this path dereferenced
  // list[0] BEFORE its own guard, so a response object with no `list` key threw
  // a bare TypeError instead of the diagnostic that names the id.
  it("names the id when the response carries no list at all", async () => {
    const call = fakeCall([[{}]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never,
      download: vi.fn(async () => Buffer.from("x")) as never });
    await expect(p.getMessage("e1")).rejects.toThrow(/e1/);
  });

  it("names the id when the message is simply not in the list", async () => {
    const call = fakeCall([[{ list: [] }]]);
    const p = makeJmapPort({ session: S, token: "t", call: call as never,
      download: vi.fn(async () => Buffer.from("x")) as never });
    await expect(p.getMessage("e1")).rejects.toThrow(/e1/);
  });
});
