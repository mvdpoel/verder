import { describe, expect, it } from "vitest";
import { listAllMessageIds, type MessageListFn } from "./gmail-auth";

describe("listAllMessageIds", () => {
  it("follows nextPageToken until the listing is exhausted", async () => {
    const pages: Record<string, { messages: { id: string }[]; nextPageToken?: string }> = {
      start: { messages: [{ id: "a1" }, { id: "a2" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "b1" }], nextPageToken: "p3" },
      p3: { messages: [{ id: "c1" }, { id: "c2" }] },
    };
    const seenTokens: (string | undefined)[] = [];
    const list: MessageListFn = async (params) => {
      seenTokens.push(params.pageToken);
      expect(params.q).toBe("newer_than:7d");
      return { data: pages[params.pageToken ?? "start"] };
    };
    const ids = await listAllMessageIds(list, "newer_than:7d");
    expect(ids).toEqual(["a1", "a2", "b1", "c1", "c2"]);
    expect(seenTokens).toEqual([undefined, "p2", "p3"]);
  });

  it("handles an empty mailbox", async () => {
    const list: MessageListFn = async () => ({ data: {} });
    expect(await listAllMessageIds(list, "newer_than:7d")).toEqual([]);
  });
});
