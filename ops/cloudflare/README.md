# Cloudflare mail front door — proven prototype, NOT production

Measured 2026-09-02. Everything here runs on **`babeltube.tech`**, a zone that
carries no mail. **Nothing here is routed at `vanderpoel.pro`**, and nothing
here changes how your mail is delivered today.

## What was proven

| Case | Sender is told | Custody |
| --- | --- | --- |
| home reachable | `250` | home has it |
| home down, spool works | `250` | the spool has it |
| home down, spool also fails | `421 4.3.0 Upstream error` | the SENDER keeps it |
| handler swallows the error | `250` | **nobody has it — the message is LOST** |

End to end, one real message: sent while home was down → accepted with 250 →
found in the spool at **2789 bytes** carrying `<m1-spool-1180430b47b8@…>` →
drained → **2789 bytes and the identical Message-ID** received at the far end.
A drain attempted while home was still down reported `delivered: 0` and **kept**
the message, which is the property that matters most.

## Files

| File | What it is |
| --- | --- |
| `spool-worker.js` | The cascade: home → spool → refuse. `accept()` and `drain()` are the whole design. |
| `home-stub.js` | Stand-in for the homelab's future ingest endpoint. Records durable receipts. |
| `smtp-code-probe.worker.js` | The earlier probe that established what SMTP code each failure produces. |
| `smtp-probe.py` | Speaks SMTP by hand and prints the response at every stage. Run it from the **homelab** — the MacBook has no outbound 25. |

## Storage: KV today, R2 later

It runs on **Workers KV**, not R2, because enabling R2 attaches an
auto-renewing subscription to a credit card and that is Martin's decision, not
an agent's. KV is adequate but has real limits: a value caps at **25 MiB**
(same as Cloudflare's inbound message cap, so the largest legal message barely
fits) and the free tier allows **1000 writes a day**. `spoolPut` and
`spoolTake` are the only two functions that know which store it is.

## Two things this prototype does NOT have

1. **A real home endpoint.** Today verder PULLS from Stalwart over JMAP; nothing
   accepts a pushed message. `home-stub.js` stands in for it. Building the real
   one is the next piece and needs its own design (auth, and how it performs
   `Email/import`).
2. **Monitoring.** A spool quietly filling up is its own outage. Before this
   goes live, the spool depth belongs on the dashboard beside the other
   workers, with the same "silence is failure" treatment `worker-health.ts`
   already applies.

## The one rule

Answer `250` only once somebody durable has the bytes. If neither home nor the
spool has it, **throw** — that becomes a 421 and the sender keeps it. A caught
and swallowed error returns 250 and loses the mail; that is measured, not
theoretical, and it is the difference between two adjacent lines of code.

## Tearing it down

Set the `babeltube.tech` catch-all back to `drop`, delete the three Workers,
the `home.babeltube.tech` route and A record, and the KV namespace.
