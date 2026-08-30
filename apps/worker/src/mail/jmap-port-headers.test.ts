import { describe, expect, it, vi } from "vitest";
import { makeJmapPort } from "./jmap-port";

const S = { apiUrl: "https://x/api", downloadUrl: "d", accountId: "a" };

function fakeCall(responses: unknown[][]) {
  let n = 0;
  return vi.fn(async (_s: unknown, _auth: unknown, _using: string[], _calls: unknown[][]) =>
    responses[Math.min(n++, responses.length - 1)]);
}
const port = (call: unknown, download: unknown = vi.fn(), limits?: { pageSize: number }) =>
  makeJmapPort({ session: S, auth: "t", call: call as never, download: download as never,
    limits });

/**
 * `Email/changes` returns ids and nothing else, so relevance — which pollMail
 * MUST decide before it ingests anything — needs the headers first. Fetching
 * them with `getMessage` would download the RFC822 blob and every attachment of
 * a message the case has no interest in, which after the 11.49 GB Takeout
 * import is years of commercial mail pulled through the wire in full.
 */
describe("JmapPort.headers", () => {
  it("asks for from, to and the Message-ID ONLY, in one Email/get for many ids", async () => {
    const call = fakeCall([[{ list: [
      { id: "e1", from: [{ email: "case@verdergroep.nl" }], to: [{ email: "m@x.nl" }],
        "header:Message-ID:asText": "<a1@verdergroep.nl>" },
      { id: "e2", from: [{ email: "deals@shop.example" }], to: [{ email: "p@shop.example" }],
        "header:Message-ID:asText": "<a2@shop.example>" },
    ] }]]);
    const r = await port(call).headers(["e1", "e2"]);

    expect(r).toEqual([
      { id: "e1", from: "case@verdergroep.nl", to: "m@x.nl",
        messageId: "a1@verdergroep.nl" },
      { id: "e2", from: "deals@shop.example", to: "p@shop.example",
        messageId: "a2@shop.example" },
    ]);
    expect(call).toHaveBeenCalledTimes(1);
    const calls = call.mock.calls[0][3] as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("Email/get");
    const args = calls[0][1] as Record<string, unknown>;
    expect(args.properties).toEqual(["id", "from", "to", "header:Message-ID:asText"]);
    // No blobId, no attachments, no bodyValues: asking for them is asking the
    // server to build exactly what this call exists to avoid.
    expect(args.fetchTextBodyValues).toBeUndefined();
  });

  /**
   * THE WHOLE POINT OF ASKING FOR IT *HERE*.
   *
   * A Stalwart Email id and a Gmail message id are different namespaces, and
   * Takeout's mbox bytes are not the bytes Gmail's API returned for the same
   * message, so neither the id nor the sha256 recognises a mail the dossier
   * already holds — measured on the archive at 130 relevant messages matching 0
   * of 107 existing rows. The Message-ID does, and it is a HEADER PROPERTY:
   * RFC 8621 §4.1.1's `header:{name}:{form}` costs no blob, so pollMail can
   * skip a known message before `getMessage` pulls the RFC822 original and
   * every attachment. Reading it out of the raw bytes instead would mean
   * downloading exactly what the skip exists to avoid, 146 270 times.
   */
  it("returns the Message-ID normalised, without the delimiting brackets", async () => {
    const call = fakeCall([[{ list: [
      { id: "e1", from: [], to: [], "header:Message-ID:asText": "  <CAF+9@mail.gmail.com>  " },
    ] }]]);
    expect(await port(call).headers(["e1"])).toEqual([
      { id: "e1", from: "", to: "", messageId: "CAF+9@mail.gmail.com" },
    ]);
  });

  // RFC 8621 answers an absent header with null, and a message without a
  // Message-ID is unusual but perfectly ingestable — it simply cannot be
  // deduped by one. Throwing here would fail the whole poll over a header the
  // sender omitted; the honest answer is "unknown", which is null.
  it("reads a message with no Message-ID as null rather than throwing", async () => {
    const call = fakeCall([[{ list: [
      { id: "e1", from: [], to: [], "header:Message-ID:asText": null },
      { id: "e2", from: [], to: [] },
      // `<>` is a value that arrived and carries no id. It must not become "",
      // which would compare EQUAL to the next message that also has none — a
      // dedup key matching unrelated mail, which drops a real document.
      { id: "e3", from: [], to: [], "header:Message-ID:asText": "<>" },
    ] }]]);
    expect((await port(call).headers(["e1", "e2", "e3"])).map((h) => h.messageId))
      .toEqual([null, null, null]);
  });

  it("downloads nothing", async () => {
    const download = vi.fn();
    const call = fakeCall([[{ list: [{ id: "e1", from: [{ email: "a@b.nl" }], to: [] }] }]]);
    await port(call, download).headers(["e1"]);
    expect(download).not.toHaveBeenCalled();
  });

  // A single Email/get with ten thousand ids is a request a server may refuse
  // outright (RFC 8620 §5 lets it cap `ids`), and one refusal would fail the
  // whole poll. Chunk at the same page size the rest of the port uses.
  it("chunks a long id list at the page size", async () => {
    const call = fakeCall([[{ list: [] }]]);
    await port(call, vi.fn(), { pageSize: 2 }).headers(["a", "b", "c", "d", "e"]);
    expect(call).toHaveBeenCalledTimes(3);
    const ids = call.mock.calls.map((c) =>
      ((c[3] as unknown[][])[0][1] as { ids: string[] }).ids);
    expect(ids).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  // FINDING D. The page size is a knob WE choose; maxObjectsInGet is what the
  // server will actually accept in one Email/get (RFC 8620 §5.1 has it reject
  // an over-long `ids` with requestTooLarge). Reading it from the session and
  // chunking at the smaller of the two is the difference between a poll that
  // works and one refused outright.
  it("chunks at the session's maxObjectsInGet when that is smaller", async () => {
    const call = fakeCall([[{ list: [] }]]);
    const p = makeJmapPort({
      session: { ...S, capabilities: { "urn:ietf:params:jmap:core": { maxObjectsInGet: 2 } } } as never,
      auth: "t", call: call as never, download: vi.fn() as never, limits: { pageSize: 500 },
    });
    await p.headers(["a", "b", "c"]);

    expect(call).toHaveBeenCalledTimes(2);
    const ids = call.mock.calls.map((c) =>
      ((c[3] as unknown[][])[0][1] as { ids: string[] }).ids);
    expect(ids).toEqual([["a", "b"], ["c"]]);
  });

  it("sends no request at all for an empty id list", async () => {
    const call = fakeCall([[{ list: [] }]]);
    expect(await port(call).headers([])).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  // Mirrors getMessage exactly — from[0], every `to` joined. The filter must
  // test the SAME strings the ingest will store, or a message is judged on an
  // address its raw_emails row does not record.
  it("reads a missing header as empty rather than throwing", async () => {
    const call = fakeCall([[{ list: [{ id: "e1", from: null, to: null }] }]]);
    expect(await port(call).headers(["e1"]))
      .toEqual([{ id: "e1", from: "", to: "", messageId: null }]);
  });

  // A message destroyed between Email/changes and this call simply is not in
  // the list. Dropping it is right; inventing a header for it is not.
  it("omits an id the store no longer holds", async () => {
    const call = fakeCall([[{ list: [{ id: "e1", from: [{ email: "a@b.nl" }], to: [] }] }]]);
    expect((await port(call).headers(["e1", "gone"])).map((h) => h.id)).toEqual(["e1"]);
  });
});
