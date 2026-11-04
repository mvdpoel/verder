// A stand-in for the homelab's future mail-ingest endpoint.
//
// It exists so the spool cascade can be tested deterministically: the real
// endpoint does not exist yet (today verder PULLS from Stalwart over JMAP; the
// Worker PUSHING to home is phase 2d and needs its own design). Without a stub,
// "home is down" could only be simulated by breaking something real.
//
//   POST /up    -> 200, and records what arrived
//   POST /down  -> 503, a home that is reachable but refusing
//   GET  /last  -> what the last accepted POST contained
//
// Deployed to workers.dev, no custom domain, nothing routed at vanderpoel.pro.

// Receipts go to KV, not a module variable: a module variable lives in ONE
// isolate, so a later GET can land somewhere that never saw the POST and
// report 'nothing received' about a delivery that plainly happened.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/last") {
      const list = await env.RECEIPTS.list({ prefix: "received/" });
      const keys = list.keys.map((k) => k.name).sort().reverse();
      if (!keys.length) return Response.json({ note: "nothing received yet" });
      return Response.json(JSON.parse(await env.RECEIPTS.get(keys[0])));
    }

    if (url.pathname === "/down") {
      return new Response("home is down", { status: 503 });
    }

    if (url.pathname === "/up") {
      const body = await request.arrayBuffer();
      // sha256 so the caller can prove the bytes survived the hop unchanged.
      const digest = await crypto.subtle.digest("SHA-256", body);
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const receipt = {
        bytes: body.byteLength,
        sha256: hex,
        messageId: request.headers.get("x-message-id"),
        at: new Date().toISOString(),
      };
      await env.RECEIPTS.put(`received/${receipt.at}`, JSON.stringify(receipt));
      return Response.json({ accepted: true, ...receipt });
    }

    return new Response("m1 home stub", { status: 404 });
  },
};
