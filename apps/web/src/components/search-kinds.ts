import {
  SEARCH_STATUSES, type SearchEntityType, type SearchStatus,
} from "@verder/core/search/entity-types";
import type { ChipTone } from "./ui/chip";

// Shared search constants. Deliberately NOT a "use client" module: both the
// server-rendered /search page and the client command palette import it, and
// exports of a client module reach server components as client references
// instead of their values (same reason as components/money-format.ts).
//
// The import is the /search/entity-types subpath, not the @verder/core barrel:
// the barrel re-exports hash.ts, whose node:crypto import cannot be resolved in
// the browser bundle the ⌘K palette pulls this module into.
//
// `ChipTone` is imported as a TYPE only, so nothing from components/ui — least
// of all the "use client" dialog the barrel re-exports — ends up in this
// module's runtime graph.

export const ENTITY_LABEL: Record<SearchEntityType, string> = {
  document: "Document",
  entry: "Logboek",
  email: "E-mail",
  financial_item: "Post",
  debt: "Vordering",
  task: "Taak",
  track: "Spoor",
  stop: "Halte",
  party: "Partij",
};

/**
 * The tone of the chip carrying a record's TYPE — and it is the same tone for
 * all nine on purpose.
 *
 * This palette spends colour on meaning: amber is "waiting on you", cyan is the
 * system's own voice, mint is "healthy", steel is "it happened". A record type
 * is none of those, so the nine-colour rainbow this map used to hold was borrowing
 * exactly the colours that have to stay reliable elsewhere — an amber chip on
 * every e-mail hit is enough to make amber stop meaning anything. The chip's own
 * word ("DOCUMENT", "HALTE") already tells the types apart; the map stays so a
 * type that ever DOES earn a tone has one place to say so.
 */
export const ENTITY_BADGE: Record<SearchEntityType, ChipTone> = {
  document: "faint",
  entry: "faint",
  email: "faint",
  financial_item: "faint",
  debt: "faint",
  task: "faint",
  track: "faint",
  stop: "faint",
  party: "faint",
};

// Why a result matched — the point is that Martin can see it, not guess it.
export const MATCH_LABEL: Record<"keyword" | "semantic" | "both", string> = {
  keyword: "op woord", semantic: "op betekenis", both: "woord + betekenis",
};
/**
 * The distinction worth a colour here is whether the MEANING half of the index
 * had a hand in the hit — that is the system reading rather than matching, and
 * cyan is the system's voice. A literal keyword hit is unremarkable and stays in
 * the ink ramp; the labels carry the rest of the difference.
 */
export const MATCH_BADGE: Record<"keyword" | "semantic" | "both", ChipTone> = {
  keyword: "mute",
  semantic: "signal",
  both: "signal",
};

// Statuses are per entity type, so picking one implicitly narrows the results
// to the types that carry it — the labels say which. Typing this as a full
// Record<SearchStatus, string> means adding a status in @verder/core without a
// label here is a compile error, not a blank <option>.
const STATUS_LABEL: Record<SearchStatus, string> = {
  inbox: "Document — postvak",
  filed: "Document — opgeborgen",
  open: "Taak — open",
  "in-progress": "Taak — mee bezig",
  waiting: "Taak — wacht op iemand",
  done: "Taak — klaar",
  dropped: "Taak — laten vallen",
  identified: "Register — geïnventariseerd (post of vordering)",
  mandatory: "Post — noodzakelijk",
  allowed: "Post — toegestaan",
  requested: "Post — opzegging aangevraagd",
  "to-cancel": "Post — op te zeggen",
  canceled: "Post — beëindigd",
  acknowledged: "Vordering — erkend",
  disputed: "Vordering — betwist",
  "in-settlement": "Vordering — in afwikkeling",
  settled: "Vordering — afgewikkeld",
};

/** The status rail, derived from the router's own vocabulary so it can never drift. */
export const STATUS_FILTERS: readonly { value: SearchStatus; label: string }[] =
  SEARCH_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }));
