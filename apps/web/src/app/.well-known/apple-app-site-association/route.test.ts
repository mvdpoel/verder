import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const saved = process.env.APPLE_TEAM_ID;
afterEach(() => {
  if (saved === undefined) delete process.env.APPLE_TEAM_ID;
  else process.env.APPLE_TEAM_ID = saved;
});

describe("GET /.well-known/apple-app-site-association", () => {
  it("serves webcredentials for the app id", async () => {
    process.env.APPLE_TEAM_ID = "ABCDE12345";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      webcredentials: { apps: ["ABCDE12345.pro.vanderpoel.verder"] },
    });
  });

  it("answers 404 when APPLE_TEAM_ID is unset", async () => {
    delete process.env.APPLE_TEAM_ID;
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("undefined");
  });
});
