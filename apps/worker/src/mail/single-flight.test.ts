import { describe, expect, it } from "vitest";
import { makeSingleFlight } from "./single-flight";

/** A promise resolved by hand, so every test here is deterministic: a timer
 *  would make "the second call happened while the first was still pending" a
 *  question about the event loop's speed rather than about the guard. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("makeSingleFlight", () => {
  it("runs a lone call and hands back its value", async () => {
    const sf = makeSingleFlight();
    const result = await sf.run(async () => 42);
    expect(result).toEqual({ ran: true, value: 42 });
    expect(sf.inFlight()).toBe(false);
  });

  // THE WHOLE POINT. mail.poll is scheduled every minute; a first sync or a
  // stalled server outlasts the tick. A second poll on the same cursor either
  // loses a delta or re-walks the mailbox, so the second call must not touch
  // fn at all — not even queued behind the first, which would run against a
  // cursor the in-flight poll is about to move.
  it("skips a second call while the first is still pending, without invoking fn", async () => {
    const sf = makeSingleFlight();
    const first = deferred<string>();
    let calls = 0;

    const running = sf.run(async () => { calls++; return first.promise; });
    expect(sf.inFlight()).toBe(true);

    const skipped = await sf.run(async () => { calls++; return "second"; });
    expect(skipped).toEqual({ ran: false });
    expect(calls).toBe(1);

    first.resolve("first");
    expect(await running).toEqual({ ran: true, value: "first" });
  });

  it("admits a later call once the first has settled", async () => {
    const sf = makeSingleFlight();
    const first = deferred<string>();
    const running = sf.run(async () => first.promise);
    expect(await sf.run(async () => "skipped")).toEqual({ ran: false });

    first.resolve("first");
    await running;
    expect(sf.inFlight()).toBe(false);
    expect(await sf.run(async () => "second")).toEqual({ ran: true, value: "second" });
  });

  // THE FAILURE THAT WOULD SILENTLY STOP ALL INGESTION: a flag released only on
  // the success path leaves the guard latched after the first throw, and every
  // later tick then reports a clean skip while nothing polls at all. Release
  // belongs in a finally, and the throw must still reach the caller so pollMail's
  // own error handling and its worker_runs row are unchanged.
  it("propagates a throwing fn and releases the guard, so the next call still runs", async () => {
    const sf = makeSingleFlight();
    await expect(sf.run(async () => { throw new Error("poll exploded"); }))
      .rejects.toThrow("poll exploded");
    expect(sf.inFlight()).toBe(false);
    expect(await sf.run(async () => "after")).toEqual({ ran: true, value: "after" });
  });

  // The same release, on the path where fn throws SYNCHRONOUSLY before its first
  // await — a mis-typed dependency at the top of the poll, say. `await fn()`
  // inside the try covers it; calling fn outside the try does not.
  it("releases the guard when fn throws before its first await", async () => {
    const sf = makeSingleFlight();
    const boom = (): Promise<never> => { throw new Error("sync boom"); };
    await expect(sf.run(boom)).rejects.toThrow("sync boom");
    expect(sf.inFlight()).toBe(false);
    expect(await sf.run(async () => "after")).toEqual({ ran: true, value: "after" });
  });
});
