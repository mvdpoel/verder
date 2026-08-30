import { isJmapMethodError, type JmapCredential, type JmapSession } from "./jmap-client";
import {
  MailCursorRejectedError, MailFirstSyncOverflowError,
  type MailChanges, type MailHeaders, type MailMessage, type MailPort, type SkippedPart,
} from "./port";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
/** RFC 8620 §3.3: a client advertises EVERY capability it relies on, and core
 *  governs the request object itself — the `using` array, back-references and
 *  the method-call envelope are all core. Mail alone is an under-declaration a
 *  strict server may refuse with unknownCapability. */
const USING = [CORE, MAIL];

export interface JmapAttachment {
  name: string | null; type: string | null;
  disposition: string | null; cid: string | null; blobId: string;
}

export interface JmapPortLimits {
  /** Ids per `Email/query` page, and `maxChanges` per `Email/changes` call. */
  pageSize: number;
  /** `Email/query` pages ONE first sync may walk before it refuses to return a
   *  cursor. 100 × 500 = 50 000 messages, well past a personal mailbox; past it
   *  something is wrong enough to want a human, and the alternative is silently
   *  stranding the remainder. */
  firstSyncPages: number;
  /** `Email/changes` pages ONE poll may drain. 20 × 500 = 10 000 ids handed to
   *  a single job — the bound exists because pollMail then downloads the raw
   *  bytes and every attachment of each one, and an unbounded drain over an
   *  imported 11 GB mailbox is a job that never ends. Truncating here is safe:
   *  the intermediate cursor comes back with it and the next poll continues. */
  changesPages: number;
}

export const DEFAULT_LIMITS: JmapPortLimits = {
  pageSize: 500, firstSyncPages: 100, changesPages: 20,
};

/** The first sync is `Email/query` back-referenced into `Email/get`: two method
 *  calls that MUST travel in one request, because the `Email/get` state is only
 *  the state of the ids it actually returned. */
const FIRST_SYNC_CALLS = 2;

/**
 * As much of `urn:ietf:params:jmap:core` as this port reads.
 *
 * Declared structurally rather than imported because `openSession` currently
 * returns only apiUrl/downloadUrl/accountId and DISCARDS the session's
 * `capabilities` object — so every field here is optional and every reader
 * copes with the whole thing being absent. When openSession learns to surface
 * capabilities this type is what it has to satisfy; until then a session simply
 * advertises nothing and the configured limits stand.
 */
interface JmapCoreCapability { maxObjectsInGet?: number; maxCallsInRequest?: number }
type MaybeCapableSession = JmapSession & {
  capabilities?: Record<string, JmapCoreCapability | undefined>;
};

/** The three DIFFERENT server-side limits one `pageSize` knob used to be spent
 *  on, resolved once per port against what the session advertises. */
interface ServerLimits {
  /** `Email/query` `limit` — and therefore the size of the back-referenced
   *  `Email/get`, which is why maxObjectsInGet bounds it. */
  queryPage: number;
  /** Ids per `Email/get` in `headers()`. */
  getIds: number;
  /** `maxChanges` per `Email/changes`. NOT bounded by maxObjectsInGet: that
   *  governs OBJECTS in a get, while Email/changes returns id strings, and RFC
   *  8620 §5.2 advertises no cap for it at all. Shrinking it here would halve
   *  the delta drain for no reason the server ever asked for. */
  maxChanges: number;
  /** What the session says one request may carry, or null when it says nothing.
   *  Only the first sync needs more than one call. */
  maxCalls: number | null;
}

/** A number the server sent that is safe to compute with. Anything else — a
 *  string, a float, a negative, a missing key — means "not advertised", never
 *  "zero", because a zero page size is an infinite loop. */
function intAtLeast(v: unknown, min: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min ? v : null;
}

/**
 * A state string this port is willing to hand back as a cursor, or null.
 *
 * FINDINGS 12 AND 13. Both halves of `changedSince` used to accept whatever
 * arrived in a state field, and the two ways that goes wrong are DIFFERENT
 * failures with the same cause:
 *
 *   undefined — `writeCursor`'s `cursor === null` test does not catch it, and
 *   `JSON.stringify` then DROPS the key from worker_runs.detail entirely. The
 *   next `readCursor` answers null, so the next poll silently re-enumerates the
 *   WHOLE mailbox as a first sync — no `resynced` flag, no error, nothing in
 *   the run row to read. On the 11.49 GB archive that is not a small thing.
 *
 *   "" — survives serialisation intact, comes back out of readCursor as a
 *   string, and is sent as `sinceState: ""` on the next delta: a different
 *   spelling of the blocker this round already killed.
 *
 * So the test is "is this a usable state", never merely "is this non-null".
 */
function usableState(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function resolveServerLimits(session: JmapSession, lim: JmapPortLimits): ServerLimits {
  const core = (session as MaybeCapableSession).capabilities?.[CORE];
  const maxGet = intAtLeast(core?.maxObjectsInGet, 1);
  // RFC 8620 §5.1: an `Email/get` naming more ids than maxObjectsInGet is
  // refused outright with requestTooLarge — so this is not a tuning knob, it is
  // the ceiling below which the request works at all.
  const bounded = maxGet === null ? lim.pageSize : Math.min(lim.pageSize, maxGet);
  return {
    queryPage: bounded,
    getIds: bounded,
    maxChanges: lim.pageSize,
    maxCalls: intAtLeast(core?.maxCallsInRequest, 1),
  };
}

/**
 * A message the port cannot date at all: no parseable `Date` header AND no
 * parseable delivery time.
 *
 * WHY THIS REFUSES rather than invents. `new Date("Tue, 32 Foo 2024")` is an
 * Invalid Date, Drizzle's pg timestamp mapper calls `.toISOString()` on it and
 * throws RangeError, and pollMail catches that into `failures` and HOLDS the
 * cursor — a failure that can never succeed on retry, so the delta grows
 * without bound and mail ingestion is dead until a human looks. That poison
 * pill is real, and the fix for the case that actually happens is one level up:
 * a malformed or missing Date header falls back to the delivery time and is
 * COUNTED (see MailDateFallback), never stalled on.
 *
 * What is left here is both timestamps unusable, and that is not a broken
 * message — `receivedAt` is a server-generated UTCDate, so a malformed one
 * means a broken STORE, which will produce the same fault for every message.
 * Stalling is then the correct outcome, and the alternative is worse: the only
 * remaining dates are ones this app would have to invent, written into
 * documents.received_at, which is evidence and append-only and cannot be
 * corrected afterwards. It is named and carries both raw values so
 * worker_runs.detail says what happened instead of showing a RangeError with no
 * bearing on the cause.
 *
 * It lives here rather than beside MailCursorRejectedError in port.ts because
 * nothing branches on it — pollMail only records String(err) — and it describes
 * a JMAP payload, not a MailPort contract.
 */
export class MailMessageUndatableError extends Error {
  constructor(
    readonly messageId: string,
    readonly sentAt: string | null,
    readonly receivedAt: string | null,
  ) {
    super(`JMAP message ${messageId} carries no usable date: sentAt=${sentAt ?? "null"}, `
      + `receivedAt=${receivedAt ?? "null"}`);
    this.name = "MailMessageUndatableError";
  }
}

/** One message dated by DELIVERY TIME because its own Date header could not be
 *  used — see Deps.onDateFallback. */
export interface MailDateFallback {
  id: string;
  /** `no-date-header` is RFC 8621's null `sentAt`: the message has no parseable
   *  Date header at all. `unparseable-date-header` is a value that arrived and
   *  did not survive `new Date`. They are worth telling apart: the second is a
   *  store emitting something it should have rejected. */
  reason: "no-date-header" | "unparseable-date-header";
  /** The delivery timestamp used instead, verbatim as the server sent it. */
  receivedAt: string;
}

/** `null` for anything `new Date` cannot turn into a real instant, INCLUDING
 *  the Invalid Date it silently returns for garbage. */
function parseJmapDate(v: string | null | undefined): Date | null {
  if (typeof v !== "string" || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * An image the HTML body embeds by cid is furniture, not a document.
 *
 * All THREE conditions are required. macOS and iOS Mail mark every attachment
 * inline and give each a Content-Id, so disposition alone would silently drop a
 * mailed Beschikking.pdf — and a skipped part never becomes a document, never
 * reaches the queue and is not recoverable by re-polling.
 */
export function isInlineBodyImage(a: JmapAttachment): boolean {
  return (a.type ?? "").startsWith("image/")
    && a.disposition === "inline"
    && !!a.cid;
}

interface Deps {
  session: JmapSession;
  /**
   * Whatever jmap-client's credential factories produce, NOT a token string.
   *
   * This field was `string`, which is a bearer token and only a bearer token —
   * so `makeJmapPort({ auth: basic(user, appPassword), … })` did not typecheck
   * and the only way to wire the deployment's actual credential was a cast at
   * the construction site. That is the one place a cast must not sit: the port
   * never inspects the credential, it only forwards it, so a wrong one is
   * caught by nothing here and surfaces much later as a 401 that reads like a
   * wrong password. `JmapCredential` still admits the plain string, so bearer
   * callers are unchanged.
   */
  auth: JmapCredential;
  call: <T>(s: JmapSession, auth: JmapCredential, using: string[], calls: unknown[][]) => Promise<T[]>;
  download: (s: JmapSession, auth: JmapCredential, blobId: string, name: string, type: string) => Promise<Buffer>;
  limits?: Partial<JmapPortLimits>;
  /**
   * Called once per message that had to be dated by DELIVERY TIME.
   *
   * `receivedAt` is when THIS store took delivery, which for anything Vandelay
   * injects from the Takeout mbox is the IMPORT DATE — a 2024 sommation whose
   * Date header the export dropped lands dated 2026, and that value flows
   * through ingestRawEmail into documents.received_at, which is evidence and
   * append-only and cannot be corrected later. Preferring the header is right;
   * doing it WITHOUT A TRACE is what this exists to stop, because the rate of
   * it is then assumed rather than known.
   *
   * An injected observer rather than a field on MailMessage or a module-level
   * counter, for one reason each: MailMessage is the MailPort contract shared
   * with the Gmail-era fake, and a module counter reports a LIFETIME total in a
   * field (worker_runs.detail) that is per-run. The port is constructed once
   * and polled many times, so the run-scoped consumer has to own the tally.
   *
   * WIRING, still owed: pollMail should collect these the way it already
   * collects skippedParts and write `dateFallbacks` into the run detail. Until
   * it does, the port counts and nothing reads — see the unresolved note.
   */
  onDateFallback?: (note: MailDateFallback) => void;
}

// `sentAt` is the Date header the sender wrote; `receivedAt` is when THIS store
// took delivery. They differ by seconds for live mail and by years for anything
// Vandelay injects from the Takeout mbox, and the value flows through
// raw_emails.sent_at into documents.received_at, which is evidence and
// append-only. Ask for both, prefer the header.
const PROPS = ["id", "threadId", "blobId", "subject", "sentAt", "receivedAt", "from", "to",
  "textBody", "bodyValues", "attachments"];

/** RFC 8620 §5.5. `limit` is present ONLY when the server clamped the one we
 *  asked for, and `position` is where the page it answered actually starts —
 *  both are the server correcting us, and both were previously discarded. */
interface QueryResponse { ids?: string[]; total?: number; limit?: number; position?: number }
/** `state` is likewise typed optional against a server that omits what RFC 8620
 *  §5.1 requires — the first sync's whole cursor is this one field. */
interface GetIdsResponse { state?: string; list?: { id: string }[] }
/** One row of a properties-limited `Email/get` — see MailPort.headers. */
interface HeaderRow {
  id: string; from: { email: string }[] | null; to: { email: string }[] | null;
}

/** `newState` is typed OPTIONAL although RFC 8620 §5.2 requires it: the point
 *  of the guard in `delta` is a server that does not do what it must, and a
 *  non-optional type here would let the compiler talk that guard away. */
interface ChangesResponse {
  newState?: string; created?: string[]; updated?: string[]; destroyed?: string[];
  hasMoreChanges?: boolean;
}

/** Append ids in arrival order, dropping ones already collected: a message that
 *  is created and then updated appears twice across the pages of one drain, and
 *  ingesting it twice is wasted downloads at best. */
function collect(into: string[], seen: Set<string>, ids: string[] | undefined): void {
  for (const id of ids ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    into.push(id);
  }
}

/**
 * FIRST SYNC — there is no cursor yet.
 *
 * `Email/changes` cannot answer this: RFC 8620 §5.2 types `sinceState` as a
 * REQUIRED String and defines no "since nothing" form, so `sinceState: null` is
 * answered with invalidArguments — and since the cursor is only written after a
 * successful poll, a null cursor stays null and every later poll repeats the
 * identical invalid request. Ingestion never starts and never heals.
 *
 * So enumerate instead: `Email/query` for the ids, back-referenced into
 * `Email/get` in the SAME round trip (`#ids`), whose `state` is the canonical
 * value `Email/changes` continues from. The query's own `queryState` is a state
 * for the QUERY, not for the Email type, and feeding it to Email/changes is a
 * different bug wearing the same shape.
 *
 * Oldest first, and the state is taken from the FIRST page: new mail lands at
 * the tail of an ascending sort, so paging cannot skip it, and anything that
 * arrives mid-enumeration is replayed by the next Email/changes rather than
 * falling between the two. A duplicate is free — pollMail already skips a
 * message id it has seen — while a gap is a lost document.
 */
async function firstSync(d: Deps, lim: JmapPortLimits, srv: ServerLimits): Promise<MailChanges> {
  // The two calls are not a convenience: without the back-reference there is no
  // single round trip whose `Email/get` state belongs to the ids it returned.
  // A session that cannot carry two says so up front rather than earning an
  // opaque refusal on the wire.
  if (srv.maxCalls !== null && srv.maxCalls < FIRST_SYNC_CALLS) {
    throw new Error(`JMAP first sync needs ${FIRST_SYNC_CALLS} method calls in one request `
      + `(Email/query back-referenced into Email/get), but the session advertises `
      + `maxCallsInRequest=${srv.maxCalls}`);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  let state: string | null = null;
  let position = 0;
  let total: number | null = null;
  let pageWasFull = false;
  /** Has the server ever handed back a page as large as the one we asked for?
   *  Until it has, a short page is genuinely ambiguous — see FINDING 14 below. */
  let askedSizeSeen = false;

  for (let page = 0; page < lim.firstSyncPages; page++) {
    const res = await d.call<unknown>(d.session, d.auth, USING, [
      ["Email/query", {
        accountId: d.session.accountId,
        sort: [{ property: "receivedAt", isAscending: true }],
        position, limit: srv.queryPage,
        calculateTotal: page === 0,
      }, "q0"],
      ["Email/get", {
        accountId: d.session.accountId,
        // The back-reference, not a copied id list: two sources for the same
        // ids disagree the moment the query moves, and a server may honour
        // either.
        "#ids": { resultOf: "q0", name: "Email/query", path: "/ids" },
        properties: ["id"],
      }, "g0"],
    ]);
    const q = (res[0] ?? {}) as QueryResponse;
    const g = (res[1] ?? {}) as GetIdsResponse;

    // FINDING 13. Taken from the FIRST page and never adopted from a later one.
    // `state ??= g.state ?? null` did both wrong things at once: it accepted an
    // empty string (which then locked itself in, since `"" ?? x` is `""`), and
    // where page 0 carried no state it silently promoted page 1's — a state the
    // mailbox has already moved past, so a message created between the two
    // pages is neither enumerated here (that page is behind us) nor replayed by
    // the next Email/changes. Refusing is the recoverable failure; adopting is
    // the silent gap.
    if (page === 0) state = usableState(g.state);
    // The ids the store actually still holds, not the ones the query listed a
    // moment earlier.
    collect(ids, seen, (g.list ?? []).map((e) => e.id));

    const returned = (q.ids ?? []).length;
    // RFC 8620 §5.5: "The server MAY choose to enforce a maximum limit
    // argument. In this case, if a greater value is given (or if it is null),
    // the limit is clamped to the maximum; the new limit is returned with the
    // response so the client is aware." Reading end-of-mailbox from the limit
    // we ASKED for turns a clamped page into a short page: the walk stops, the
    // overflow guard never fires, and pollMail writes a cursor meaning
    // "everything up to this state is accounted for" over a PARTIAL
    // enumeration. The messages past the clamp are then neither created nor
    // updated after that state, so Email/changes never returns them — stranded
    // permanently and silently, on the 11.49 GB first sync where it matters
    // most. So the server's limit wins over ours whenever it sent one.
    const statedLimit = intAtLeast(q.limit, 1);
    const limit = statedLimit ?? srv.queryPage;
    if (returned >= srv.queryPage) askedSizeSeen = true;
    // Likewise the server says where the page it answered actually starts;
    // trust that over a count we kept ourselves.
    position = (intAtLeast(q.position, 0) ?? position) + returned;
    // `total` is requested on the first page only and may move under us, so it
    // may only ever ADD a page, never end the walk early — and `returned > 0`
    // keeps a stale, too-high total from spinning the loop into a false
    // overflow: an empty page is the end of the list whatever the total claims.
    total ??= intAtLeast(q.total, 0);
    const moreByTotal = total !== null && position < total;
    // FINDING 14. Everything above rests on the server obeying an RFC MUST. A
    // server that clamps the page WITHOUT echoing `limit` — and `calculateTotal`
    // is asked for on page 0 only, so `total` may also be absent — makes the
    // very first page look short. The walk ends, the overflow guard never
    // fires, and firstSync hands back a cursor meaning "everything up to this
    // state is accounted for" over a PARTIAL enumeration: the same silent,
    // permanent strand the clamp guard exists to prevent, through another door.
    //
    // Nothing in a short page distinguishes a silent clamp from a small
    // mailbox, so the port stops guessing and asks. A short page is accepted as
    // the end of the list only where the server CONFIRMED the limit, ACCOUNTED
    // for the list with a total, or has already handed back a page of the size
    // we asked for; otherwise the walk continues and only an EMPTY page ends
    // it. The cost is one confirming round trip on a mailbox smaller than a
    // page — paid once per first sync, and only there.
    const shortIsAmbiguous = statedLimit === null && total === null && !askedSizeSeen;
    pageWasFull = returned > 0 && (returned >= limit || moreByTotal || shortIsAmbiguous);
    if (!pageWasFull) break;
  }

  if (pageWasFull) throw new MailFirstSyncOverflowError(ids.length, lim.firstSyncPages);
  if (state === null) {
    throw new Error("JMAP first sync: Email/get returned no usable state to sync from "
      + "(an absent or empty state is not a cursor)");
  }
  return { ids, cursor: state, hasMore: false };
}

/**
 * DELTA — everything that changed since the cursor.
 *
 * Drained across pages because RFC 8620 §5.2 caps a response at `maxChanges`
 * and answers with an INTERMEDIATE newState plus `hasMoreChanges: true`,
 * expecting the client to call again. Reading only the first page loses
 * nothing (the state carries forward) but reports a finished-looking run while
 * thousands wait, which is exactly what an imported mailbox looks like.
 */
async function delta(
  d: Deps, lim: JmapPortLimits, srv: ServerLimits, cursor: string,
): Promise<MailChanges> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let state = cursor;
  let hasMore = false;

  for (let page = 0; page < lim.changesPages; page++) {
    let r: ChangesResponse;
    try {
      [r] = await d.call<ChangesResponse>(d.session, d.auth, USING, [["Email/changes", {
        accountId: d.session.accountId, sinceState: state, maxChanges: srv.maxChanges,
      }, "c0"]]);
    } catch (err) {
      // Named, not swallowed: the poll layer owns the resync policy, this layer
      // owns making the condition recognisable without string matching. Every
      // other failure — a socket reset, another JMAP method error — passes
      // through untouched, or a transport blip would drop a healthy cursor.
      if (isJmapMethodError(err, "cannotCalculateChanges")) {
        throw new MailCursorRejectedError(state, { cause: err });
      }
      throw err;
    }
    // `destroyed` is deliberately dropped: there is nothing to ingest, and the
    // vault is append-only anyway.
    collect(ids, seen, r.created);
    collect(ids, seen, r.updated);
    // FINDING 12. `state = r.newState` accepted undefined, and an undefined
    // cursor is worse than an error: writeCursor does not catch it, JSON drops
    // the key, and the next poll re-enumerates the whole mailbox as a first
    // sync without recording that it did. Refusing here holds the cursor pollMail
    // already has and colours the run red, which is the loud, recoverable half
    // of the same fault.
    const next = usableState(r.newState);
    if (next === null) {
      throw new Error(`JMAP Email/changes answered sinceState=${state} with no usable `
        + `newState (got ${JSON.stringify(r.newState)}); refusing to advance the cursor`);
    }
    state = next;
    hasMore = r.hasMoreChanges === true;
    if (!hasMore) break;
  }

  return { ids, cursor: state, hasMore };
}

export function makeJmapPort(d: Deps): MailPort {
  const lim: JmapPortLimits = { ...DEFAULT_LIMITS, ...d.limits };
  // Resolved once: the session is fixed for the life of the port, and reading
  // the capabilities per call would re-derive the same three numbers per page.
  const srv = resolveServerLimits(d.session, lim);
  return {
    async changedSince(cursor) {
      return cursor === null ? firstSync(d, lim, srv) : delta(d, lim, srv, cursor);
    },

    async headers(ids): Promise<MailHeaders[]> {
      const out: MailHeaders[] = [];
      // An empty list must send NO request: `Email/get` with `ids: []` is a
      // round trip that can only answer "nothing", and every quiet poll would
      // make one.
      for (let i = 0; i < ids.length; i += srv.getIds) {
        // Chunked at the SMALLER of our page size and the session's advertised
        // maxObjectsInGet: RFC 8620 §5.1 has the server refuse an over-long
        // `ids` with requestTooLarge, and one refusal fails the whole poll.
        const [r] = await d.call<{ list?: HeaderRow[] }>(d.session, d.auth, USING,
          [["Email/get", {
            accountId: d.session.accountId, ids: ids.slice(i, i + srv.getIds),
            // NOT `blobId`, `attachments` or `bodyValues`: asking for them is
            // asking the server to assemble exactly what this call exists to
            // avoid fetching.
            properties: ["id", "from", "to"],
          }, "h0"]]);
        for (const e of r.list ?? []) {
          out.push({ id: e.id, from: e.from?.[0]?.email ?? "",
            to: (e.to ?? []).map((x) => x.email).join(", ") });
        }
      }
      return out;
    },

    async getMessage(id): Promise<MailMessage> {
      const [r] = await d.call<{ list?: Record<string, never>[] }>(
        d.session, d.auth, USING, [["Email/get", {
          accountId: d.session.accountId, ids: [id], properties: PROPS,
          fetchTextBodyValues: true,
        }, "c0"]]);
      // `r.list ?? []`, exactly as headers() does: a response object with no
      // `list` key at all used to be dereferenced BEFORE the guard below, so it
      // died as a bare TypeError with no bearing on the cause instead of the
      // diagnostic that names the message.
      const e = (r.list ?? [])[0] as unknown as {
        id: string; threadId: string; blobId: string; subject: string | null;
        sentAt: string | null; receivedAt: string;
        from: { email: string }[] | null; to: { email: string }[] | null;
        textBody: { partId: string }[] | null;
        bodyValues: Record<string, { value: string }> | null;
        attachments: JmapAttachment[] | null;
      };
      if (!e) throw new Error(`JMAP Email/get returned nothing for ${id}`);

      // Dated BEFORE any blob is downloaded: a message this port cannot date is
      // refused, and refusing it after pulling the RFC822 original and every
      // attachment through the wire is bytes spent on a message that is not
      // going to be ingested.
      let when = parseJmapDate(e.sentAt);
      let dateNote: MailDateFallback | null = null;
      if (!when) {
        const delivered = parseJmapDate(e.receivedAt);
        if (!delivered) {
          throw new MailMessageUndatableError(id, e.sentAt ?? null, e.receivedAt ?? null);
        }
        when = delivered;
        dateNote = {
          id, receivedAt: e.receivedAt,
          // A header that arrived and did not parse is a different fault from
          // one that was never there: the second is the store emitting
          // something it should have rejected.
          reason: e.sentAt == null ? "no-date-header" : "unparseable-date-header",
        };
      }

      const attachments: MailMessage["attachments"] = [];
      const skippedParts: SkippedPart[] = [];
      for (const a of e.attachments ?? []) {
        const mime = a.type ?? "application/octet-stream";
        const name = a.name ?? "unnamed";
        if (isInlineBodyImage(a)) {
          skippedParts.push({ filename: name, mime, contentId: a.cid });
        } else {
          attachments.push({ filename: name, mime,
            data: await d.download(d.session, d.auth, a.blobId, name, mime) });
        }
      }

      // The Email's own blobId IS the RFC822 original — one download, and the
      // same canonical bytes the vault has always stored.
      const raw = await d.download(d.session, d.auth, e.blobId, "raw.eml", "message/rfc822");

      // Reported only once the message is fully assembled: a getMessage that
      // died on a download is retried by the next poll, and counting it here
      // would inflate the rate of delivery-dated mail with attempts that never
      // reached the dossier.
      if (dateNote) d.onDateFallback?.(dateNote);

      const partId = e.textBody?.[0]?.partId;
      return {
        id: e.id, threadId: e.threadId,
        from: e.from?.[0]?.email ?? "",
        to: (e.to ?? []).map((x) => x.email).join(", "),
        subject: e.subject ?? "(no subject)",
        // The Date header, falling back to delivery time only when the message
        // carries none the port can use. An import that stamps receivedAt with
        // the import date would otherwise date every historical mail to the day
        // of the import, inside evidence that cannot be corrected afterwards —
        // which is why the fallback is counted rather than merely preferred
        // against.
        sentAt: when,
        bodyText: (partId && e.bodyValues?.[partId]?.value) || "",
        raw,
        attachments, skippedParts,
      };
    },
  };
}
