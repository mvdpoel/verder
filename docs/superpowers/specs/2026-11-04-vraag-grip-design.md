# Vraag Grip — ask the app to do something

Date: 2026-11-04. Status: approved by Martin in chat (named "Vraag Grip" after the rename to Grip, same day) ("Also live Gmail search", "build it now, but use figma for the designs").

## Why

On 2026-11-04 two things happened that the app could not handle and a Claude session did:

1. Regio 3 mailed a boedelbeschrijving. Martin asked "help me answer this, check the facts". Claude read the dossier itself (the intake in April, the box of papers Demi collected on 29 April, the LBIO letter of 11-01-2022, the BKR overview, his own creditor list of 25 October), found what the form was missing, drafted a reply with two vault attachments, and sent it only after Martin said "Go".
2. Martin scanned a UNHCR letter and said "unsubscribe me in full". Claude found the scan, then a running € 10 monthly incasso in the bank statements, and worked out what had to happen.

Grip (the app, called verder until 2026-11-04) reacts to what arrives (proposals per incoming mail, clocks, suggestions). Martin cannot START anything. "Vraag Grip" is that missing direction: a request in his own words, researched by Claude against the dossier, answered in the app, and — when it needs a mail — turned into an ordinary proposal that he approves behind Face ID.

## The laws this must keep

- **Nothing is sent without Martin's approval of the final text.** The request runner has NO send tool. The only way out is a `proposals` row in `pending`, which goes through the existing approval screen and `proposal-send`.
- **AI output is suggestion-only.** The runner writes nothing to evidence tables. It cannot file, discard, purge, change a task, create a debt or a log entry. Its only write is through `requests-store`, which validates everything.
- **Everything is recorded** (golden rule): the request, the prompt, the model, every tool call and a hash of every tool result, the raw model output, the answer, and Martin's verdict on any proposal (the existing approved/edited/rejected + diff).
- **Reading is enforced, not promised.** Every tool runs its queries inside `SET TRANSACTION READ ONLY`, so even a bug in a tool cannot write. Gmail uses the worker's existing token, whose OAuth scope is `gmail.readonly`.
- **The Claude token never enters a container or argv** — the same discipline as `ops/proposal-drafter.sh`.
- **Effective status everywhere**: tools read documents through the effective status/title/doc type (`effective-status.ts`); discarded and purged documents are not returned (a purged one has no text anyway).

## The flow

1. **Ask.** On the phone Martin types or dictates (the existing `Transcriber`) a request. He may attach what it is about: a mail, a document, a party, a stop, a task — from the item's context menu ("Vraag Grip hierover") or from the compose sheet. The phone posts it with a `clientId` (idempotent, like voice entries); offline it waits in the local queue.
2. **Queue.** `POST /api/mobile/v1/requests` writes a `requests` row, status `queued`. The request shows at the top of Voor jou as "Grip zoekt het uit" (not amber: it waits on Grip, not on Martin).
3. **Research.** The host cron `ops/request-runner.sh` (every minute, `flock`, one request at a time) claims the oldest queued request (`requests-pending --claim` → `working`) and runs
   `claude -p --tools "" --strict-mcp-config --mcp-config <grip-tools> --allowedTools "mcp__grip__*" --max-turns 40 --no-session-persistence`
   with the prompt on stdin and the token in that one process's environment. `<grip-tools>` is a stdio MCP server started INSIDE the worker container (`docker compose exec -T worker pnpm --silent --filter worker grip-tools`). Hard timeout 600 s.
4. **Answer.** Claude ends with one JSON object (schema below). `requests-store` validates it against the request's tool log and writes the answer, sources and — if present — a proposal. Status `answered` (or `failed` with the reason).
5. **Tell.** One push: "Grip heeft je vraag uitgezocht" (no case content on the lock screen). An answered request Martin has not opened counts as waiting on him (it joins `loadWaiting`, so badge, widget and Voor jou agree).
6. **Act.** The answer screen shows the answer, the sources (each opens the document, mail, bank row or stop), the steps only Martin can do ("Zeg de machtiging op via je bank" — Grip cannot), and the proposal card, which opens the EXISTING proposal screen. "Vraag door" asks a follow-up in the same thread.

## The tools (read-only, in `apps/worker/src/requests/tools/`)

Each returns compact JSON, never more than ~8 000 characters (long texts are paged with an `offset`), and every result carries the ids it showed, so `requests-store` can check citations.

| Tool | What it reads |
|---|---|
| `search` | the existing hybrid retrieval (`search/retrieve.ts`), all entity types |
| `get_document` | one document: effective title, soort, party, received date, extracted text (paged) |
| `list_documents` | filter by soort, party, period, source; newest first |
| `get_mail` | one `raw_emails` row: from, to, cc, date, subject, body (HTML stripped), attachments as document ids |
| `list_mail` | Grip's mail by party / address / period / subject words |
| `gmail_search` | LIVE Gmail search (Gmail query syntax), ids + headers only, max 20 results |
| `gmail_read` | one live Gmail message: headers, text body, attachment names (bytes are never fetched) |
| `list_transactions` | bank rows by account, period, counterparty, amount, description words |
| `get_party` / `list_parties` | parties with email, kind, debts, open tasks |
| `list_debts` | the registry: claimed amounts (unknown stays unknown), parties per role |
| `case_map` | the tracks and stops (`buildTrackMap` input), current stop |
| `list_tasks` / `list_entries` | tasks with effective status; logbook entries |

Gmail is wider than the dossier (it holds unrelated business mail). Two bounds: at most 10 `gmail_search` + 20 `gmail_read` calls per request, and the existing `rateLimitedUntil` memory is honoured (a request during a Gmail lockout answers without Gmail and says so). Gmail mail Claude cites is NOT ingested by this feature; if a proposal replies to it, the proposal carries it as `triggerExternal`, exactly as the mail agent's proposals do.

## The answer schema (what `requests-store` accepts)

```json
{
  "answer": "Dutch, to Martin, supportive, short paragraphs",
  "sources": [{ "type": "document|mail|gmail|transaction|party|debt|stop|task|entry", "id": "…", "why": "one line" }],
  "martinSteps": ["what only Martin can do, in Dutch"],
  "proposal": null | {
    "kind": "reply | compose",
    "to": ["…"], "cc": ["…"],
    "subject": "…", "body": "Dutch, official register",
    "attachments": ["document id"],
    "inReplyTo": { "rawEmailId": "…" } | { "gmailId": "…" } | null
  }
}
```

Refused (request `failed`, reason recorded, nothing created) when: a source id or attachment id never appeared in a tool result; a recipient address never appeared in a tool result (the same rule `proposals-store` applies to its context); an attachment is discarded or purged; `inReplyTo` names a message not read through a tool; the JSON does not parse. Claude may answer WITHOUT a proposal — most answers will be just an answer.

## Data (migration 0044, additive)

- `requests`: `id`, `client_id` UNIQUE, `parent_request_id` (follow-ups), `text`, `about` jsonb (`{rawEmailId|documentId|partyId|stopId|taskId}`), `status` (`queued, working, answered, failed, cancelled`), `answer`, `sources` jsonb, `martin_steps` jsonb, `proposal_id` → proposals, `prompt`, `prompt_version`, `model`, `model_output`, `tool_log` jsonb (`[{tool, args, resultSha256, ids, ms}]`), `error`, `opened_at`, `created_at`, `claimed_at`, `answered_at`, `updated_at`.
- `proposals`: `trigger_request_id` → requests, kind check gains `compose` (a new mail, not a reply).
- Grants: `grip_app` SELECT, INSERT, UPDATE on `requests` (cancel, mark opened); `grip_worker` SELECT, INSERT, UPDATE. No DELETE. Not evidence: no ledger event. (A proposal that is SENT still writes its `entry.created`, as today.)
- SAME ORDERING TRAP as every migration: rsync, migrate from the HOST, then rebuild web+worker.

## Phone

- **Entry points:** a "Vraag Grip" button on Overzicht and in Voor jou's toolbar; "Vraag Grip hierover" in the context menu of a mail, document, party, stop and task (it pre-attaches that item).
- **Compose sheet:** a text field (grows), a mic button (hold or tap to dictate, live transcript into the field), the attached item as a removable chip, "Versturen". Offline: "Wordt verstuurd zodra je online bent".
- **Voor jou:** a request row per open request — `queued` "In de wachtrij", `working` "Grip zoekt het uit · 2 min", `answered` (unread: waits on Martin), `failed` "Lukte niet · Opnieuw".
- **Answer screen:** the question (Martin's words), the answer, "Bronnen" (tappable), "Wat jij nog moet doen", the proposal card, "Vraag door". While working: what Grip is doing ("leest 4 documenten, zoekt in Gmail") from the tool log, live by polling.
- **Cancel** while queued or working (the runner checks the status before storing; a cancelled request's answer is discarded).

## Limits and failure

- One request at a time; ~1–5 min typical, 600 s hard stop → `failed` "Duurde te lang".
- The runner records a `request-runner` `worker_runs` row per run (watcher, 1 min); a stuck `working` older than 15 min is reset to `failed` by the next run.
- Prompt injection: mail and document text are untrusted data. The system prompt says so; and the structural guard is that no tool can act — the worst an injected instruction can do is shape a draft Martin reads before anything leaves.

## Out of scope (now)

Actions outside mail (bank, websites, calls), ingesting live Gmail results into the vault, voice replies, multi-request parallelism.
