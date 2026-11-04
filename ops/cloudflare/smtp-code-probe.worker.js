// M1 — measuring what a SENDING MTA is told when a Cloudflare Email Worker fails.
//
// This is the one fact the Cloudflare documentation does not state, and it is
// what decides option C in the mail architecture review:
//
//   4xx  the sender queues and retries for days, so we need no queue of our own
//        and a home outage costs nothing but latency.
//   5xx  the message bounces, so the Worker may never fail, and option C needs
//        a buffer (Queues / R2) in front of anything that can be down.
//
// ONE Worker, switched by the RECIPIENT LOCALPART, so every case is measured in
// the same deployment and no redeploy can change a variable between runs:
//
//   ok@       returns normally                  -> the success baseline
//   throw@    throws an Error                   -> the case that matters
//   reject@   message.setReject(...)            -> the documented refusal
//   fetchbad@ fetch() to an unroutable host     -> "the tunnel is down"
//   slow@     sleeps past any plausible budget  -> "the homelab is wedged"
//
// The Worker deliberately does NOT call forward(): forwarding needs a verified
// destination address, and a verification click is a dependency this
// measurement does not need. What is being measured is the SMTP conversation,
// not delivery.
//
// NEVER deploy this against a zone that carries real mail. The measurement runs
// on an empty zone; enabling Email Routing rewrites the APEX MX and the apex
// SPF of whatever zone it is enabled on, which on vanderpoel.pro would take
// live mail away from Google mid-bewindvoering.

const HDR = (h, n) => { try { return h.get(n) || ""; } catch { return ""; } };

export default {
  async email(message, env, ctx) {
    const to = String(message.to || "").toLowerCase();
    const local = to.split("@")[0];
    const tag = `[m1] to=${to} from=${message.from} size=${message.rawSize} ` +
      `msgid=${HDR(message.headers, "message-id")} subject=${HDR(message.headers, "subject")}`;

    // Logged before the branch, so `wrangler tail` proves the handler ran even
    // in the cases where it is about to die. A case that never logs did not
    // reach the Worker at all, which is a different finding from a case that
    // reached it and failed.
    console.log(tag);

    switch (local) {
      case "throw":
        console.log("[m1] about to throw");
        throw new Error("m1: deliberate handler failure");

      case "reject":
        console.log("[m1] about to setReject");
        message.setReject("m1: deliberate rejection");
        return;

      case "fetchbad": {
        // The realistic option-C failure: the Worker is fine, the tunnel or the
        // homelab behind it is not. An unroutable address inside a documented
        // TEST-NET range, so nothing real is contacted.
        console.log("[m1] about to fetch an unroutable host");
        const r = await fetch("https://192.0.2.1/ingest", {
          method: "POST",
          body: message.raw,
        });
        console.log("[m1] unexpected fetch success " + r.status);
        return;
      }


      case "fetchstrict": {
        // THE DIFFERENCE THAT MATTERS, and `fetchbad` above measured 250 which
        // made it ambiguous: either the fetch threw and something swallowed it,
        // or Workers returned an error RESPONSE for an unroutable address and
        // the handler then returned normally. This case removes the ambiguity by
        // treating anything that is not a 2xx as a failure, which is what real
        // ingestion code must do.
        console.log("[m1] strict fetch to an unroutable host");
        let r;
        try {
          r = await fetch("https://192.0.2.1/ingest", { method: "POST", body: message.raw });
        } catch (e) {
          console.log("[m1] fetch THREW: " + e);
          throw new Error("m1: delivery failed (fetch threw): " + e);
        }
        console.log("[m1] fetch RETURNED status " + r.status);
        if (!r.ok) throw new Error("m1: delivery failed, upstream status " + r.status);
        return;
      }

      case "dnsfail": {
        // A name that cannot resolve, which is the other shape of "the tunnel
        // is gone". Kept separate from the unroutable-IP case because Workers
        // may treat the two differently.
        console.log("[m1] fetch to an unresolvable name");
        try {
          const r = await fetch("https://m1-does-not-exist.invalid/ingest", {
            method: "POST", body: message.raw,
          });
          console.log("[m1] unexpectedly returned " + r.status);
          if (!r.ok) throw new Error("m1: upstream status " + r.status);
        } catch (e) {
          console.log("[m1] dnsfail threw: " + e);
          throw new Error("m1: delivery failed (dns): " + e);
        }
        return;
      }

      case "slow": {
        console.log("[m1] sleeping 120s");
        await new Promise((res) => setTimeout(res, 120000));
        console.log("[m1] finished sleeping");
        return;
      }

      default:
        // The baseline. Read the body to prove the raw bytes are reachable,
        // which is the half of option C that has to work for ingestion.
        try {
          const buf = await new Response(message.raw).arrayBuffer();
          console.log(`[m1] ok, read ${buf.byteLength} raw bytes`);
        } catch (e) {
          console.log(`[m1] ok-branch could not read raw: ${e}`);
        }
        return;
    }
  },
};
