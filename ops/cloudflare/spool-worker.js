// The spool cascade — the Worker that decides who is holding a message.
//
// THE WHOLE POINT, in one rule: we answer 250 to the sending server ONLY when
// somebody durable already has the bytes. Home has them, or the spool has them.
// If neither does, we throw, Cloudflare turns that into 421, and the SENDER
// keeps it. Measured 2026-09-02: throw -> `421 4.3.0 Upstream error`, and a
// swallowed error -> 250 with the message gone. That difference is this file.
//
// STORAGE IS KV, NOT R2, and deliberately: R2 needs an account subscription
// attached to a credit card, which is Martin's click and not mine. `spoolPut`
// and `spoolTake` are the only two places that know which store it is, so
// moving to R2 later is those two functions.
//
// KV's limits are adequate but not generous: a value caps at 25 MiB, which is
// the same ceiling Cloudflare puts on an inbound message, and the free tier
// allows 1000 writes a day. Both are far above one person's outage backlog.

const SPOOL_PREFIX = "msg/";

/** How many spooled messages one drain pass will try. Bounded so a long backlog
 *  cannot run past the Worker's CPU budget and lose the whole pass. */
const DRAIN_BATCH = 25;

/**
 * Hand the message to the homelab. Throws on anything that is not a 2xx, which
 * is what makes a refusing-but-reachable home count as a failure rather than a
 * delivery. A silent non-2xx here is exactly how mail gets accepted and lost.
 */
async function deliverHome(homeUrl, raw, messageId) {
  const r = await fetch(homeUrl, {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "message/rfc822",
      "x-message-id": messageId ?? "",
    },
  });
  if (!r.ok) throw new Error(`home returned ${r.status}`);
  return r.status;
}

/** Durable custody. Resolving means the bytes are stored; only then may we
 *  answer 250. The key sorts by time so a drain delivers oldest first. */
async function spoolPut(store, raw, meta) {
  const key = `${SPOOL_PREFIX}${new Date().toISOString()}-${crypto.randomUUID()}`;
  await store.put(key, raw, { metadata: meta });
  return key;
}

async function spoolList(store, limit) {
  return store.list({ prefix: SPOOL_PREFIX, limit });
}

async function spoolTake(store, key) {
  return store.get(key, "arrayBuffer");
}

/**
 * THE CASCADE. Pure of the email API so it can be reasoned about and tested on
 * its own: home, then spool, then refuse. Returns how custody was resolved, and
 * THROWS only when nobody has it.
 */
export async function accept({ raw, messageId, homeUrl, store }) {
  let homeError;
  try {
    await deliverHome(homeUrl, raw, messageId);
    return { outcome: "delivered" };
  } catch (e) {
    homeError = e;
  }
  try {
    const key = await spoolPut(store, raw, {
      messageId: messageId ?? null,
      bytes: raw.byteLength,
      spooledAt: new Date().toISOString(),
      homeError: String(homeError),
    });
    return { outcome: "spooled", key };
  } catch (spoolError) {
    // Neither holds it. Throwing is the ONLY correct move: it becomes a 421 and
    // the sending server keeps the message and retries.
    throw new Error(
      `nobody has this message — home: ${homeError}; spool: ${spoolError}`,
    );
  }
}

/**
 * Deliver what is waiting. Deletes a spooled message ONLY after home has
 * accepted it, and stops at the first failure because a still-down home will
 * fail for every remaining message too.
 */
export async function drain(store, homeUrl, limit = DRAIN_BATCH) {
  const listed = await spoolList(store, limit);
  const result = { attempted: 0, delivered: 0, remaining: listed.keys.length, stoppedBecause: null };
  for (const k of listed.keys) {
    result.attempted++;
    const raw = await spoolTake(store, k.name);
    if (!raw) {
      // Vanished between list and get. Nothing to deliver, nothing to keep.
      await store.delete(k.name);
      continue;
    }
    try {
      await deliverHome(homeUrl, raw, k.metadata?.messageId);
    } catch (e) {
      result.stoppedBecause = String(e);
      break;
    }
    await store.delete(k.name);
    result.delivered++;
  }
  result.remaining = Math.max(0, listed.keys.length - result.delivered);
  return result;
}

/** A store whose put always fails, so the "nobody has it" branch can be
 *  exercised for real rather than by passing null and hoping. */
const brokenStore = {
  put: async () => { throw new Error("simulated spool outage"); },
};

export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();
    const messageId = message.headers.get("message-id");
    const local = String(message.to || "").toLowerCase().split("@")[0];

    // PROBE SWITCH ONLY. Production has one home URL and one store; the
    // recipient decides nothing. It is here so all three branches can be
    // measured in one deployment, against the same cascade code.
    const homeUrl = (local === "spool" || local === "hard") ? env.HOME_DOWN : env.HOME_UP;
    const store = (local === "hard") ? brokenStore : env.SPOOL;

    const res = await accept({ raw, messageId, homeUrl, store });
    console.log(`[spool] to=${message.to} bytes=${raw.byteLength} -> ${JSON.stringify(res)}`);
  },

  async scheduled(event, env, ctx) {
    const res = await drain(env.SPOOL, env.HOME_UP);
    console.log(`[drain] ${JSON.stringify(res)}`);
  },

  // Manual drain, so the scheduled path can be exercised without waiting for
  // cron. Gated on a shared secret: an open drain endpoint would let anyone
  // force delivery attempts.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/drain") return new Response("not found", { status: 404 });
    if (url.searchParams.get("key") !== env.DRAIN_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    const target = url.searchParams.get("home") === "down" ? env.HOME_DOWN : env.HOME_UP;
    return Response.json(await drain(env.SPOOL, target));
  },
};
