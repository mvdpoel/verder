import { describe, expect, it } from "vitest";
import { validateDraft } from "./validate-draft";
import { fixtureContext } from "./draft-fixture";

type Ctx = ReturnType<typeof fixtureContext>;

function reply(ctx: Ctx, over: Record<string, unknown> = {}) {
  return {
    ask: "Loonstrook oktober aanleveren",
    dueAt: null,
    missing: [],
    entrySummary: "Loonstrook september nogmaals gestuurd",
    reply: {
      to: ["opstart@verdergroep.nl"], cc: [] as string[], subject: "Re: Informatie over uw dossier",
      body: "Beste Team Opstart,\n\nIn de bijlage de loonstrook.\n\nMet vriendelijke groet,\nMartin van der Poel",
      attachmentDocumentIds: [ctx.ids.attachment],
    },
    task: null,
    question: null,
    reliedOn: [{ type: "email", id: ctx.ids.trigger, why: "de vraag" }],
    ...over,
  };
}

function question(ctx: Ctx, options: unknown[]) {
  return reply(ctx, {
    reply: null,
    question: { prompt: "Welke loonstrook bedoelen ze?", options },
  });
}

const none = { action: "none", label: "Niets doen" };
const run = (ctx: Ctx, draft: unknown) => validateDraft(JSON.stringify(draft), ctx);
const reason = (r: ReturnType<typeof validateDraft>) => (r.ok ? "ok" : r.reason);

describe("validateDraft", () => {
  it("accepts a minimal valid reply", () => {
    const ctx = fixtureContext();
    const r = run(ctx, reply(ctx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.reply?.to).toEqual(["opstart@verdergroep.nl"]);
    expect(r.payload.question).toBeNull();
    // reliedOn takes its type from the context, not from the model.
    expect(r.reliedOn).toEqual([{ type: "email", id: ctx.ids.trigger, why: "de vraag" }]);
  });

  it("accepts an answer wrapped in one json code fence", () => {
    const ctx = fixtureContext();
    const r = validateDraft("```json\n" + JSON.stringify(reply(ctx)) + "\n```\n", ctx);
    expect(reason(r)).toBe("ok");
  });

  it("refuses text that is not JSON", () => {
    const ctx = fixtureContext();
    expect(reason(validateDraft("Hier is mijn concept: ...", ctx))).toMatch(/not JSON/);
    expect(reason(validateDraft("", ctx))).toMatch(/not JSON/);
  });

  it("rejects a recipient not in context", () => {
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.to = ["attacker@evil.tld"];
    expect(reason(run(ctx, d))).toMatch(/recipient.*attacker@evil\.tld/);
    const c = reply(ctx);
    c.reply!.cc = ["someone@verdergroep.nl"];
    expect(reason(run(ctx, c))).toMatch(/recipient/);
  });

  it("compares recipients case-insensitively", () => {
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.to = ["Opstart@VerderGroep.nl"];
    const r = run(ctx, d);
    expect(reason(r)).toBe("ok");
    if (r.ok) expect(r.payload.reply?.to).toEqual(["opstart@verdergroep.nl"]);
  });

  it("a reply needs a recipient", () => {
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.to = [];
    expect(reason(run(ctx, d))).toMatch(/recipient/);
  });

  it("rejects an uncited document id", () => {
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.attachmentDocumentIds = [crypto.randomUUID()];
    expect(reason(run(ctx, d))).toMatch(/attachment/);
    const r = reply(ctx, { reliedOn: [{ type: "document", id: crypto.randomUUID(), why: "x" }] });
    expect(reason(run(ctx, r))).toMatch(/reliedOn/);
  });

  it("rejects a discarded attachment", () => {
    // In the thread (as an attachment of the trigger), but not attachable.
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.attachmentDocumentIds = [ctx.ids.discarded];
    expect(reason(run(ctx, d))).toMatch(/attachment/);
  });

  it("rejects an invented subject", () => {
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.subject = "Loonstrook";
    expect(reason(run(ctx, d))).toMatch(/subject/);
  });

  it("a new mail (no reply context) needs a subject of its own", () => {
    const ctx = fixtureContext();
    ctx.reply = null;
    const d = reply(ctx);
    d.reply!.subject = "  ";
    expect(reason(run(ctx, d))).toMatch(/subject/);
    d.reply!.subject = "Loonstrook oktober";
    expect(reason(run(ctx, d))).toBe("ok");
  });

  it("rejects an empty body", () => {
    const ctx = fixtureContext();
    const d = reply(ctx);
    d.reply!.body = " \n ";
    expect(reason(run(ctx, d))).toMatch(/body/);
  });

  it("exactly one of reply and question", () => {
    const ctx = fixtureContext();
    expect(reason(run(ctx, reply(ctx, { question: { prompt: "x", options: [none, none] } }))))
      .toMatch(/exactly one/);
    expect(reason(run(ctx, reply(ctx, { reply: null })))).toMatch(/exactly one/);
  });

  it("entrySummary must be 1 to 100 characters", () => {
    const ctx = fixtureContext();
    expect(reason(run(ctx, reply(ctx, { entrySummary: "" })))).toMatch(/entrySummary/);
    expect(reason(run(ctx, reply(ctx, { entrySummary: "x".repeat(101) })))).toMatch(/entrySummary/);
    expect(reason(run(ctx, reply(ctx, { entrySummary: "x".repeat(100) })))).toBe("ok");
  });

  it("ask must be 1 to 120 characters", () => {
    const ctx = fixtureContext();
    expect(reason(run(ctx, reply(ctx, { ask: "" })))).toMatch(/ask/);
    expect(reason(run(ctx, reply(ctx, { ask: "x".repeat(121) })))).toMatch(/ask/);
  });

  it("question needs 2 to 4 options", () => {
    const ctx = fixtureContext();
    expect(reason(run(ctx, question(ctx, [none])))).toMatch(/2 to 4 options/);
    expect(reason(run(ctx, question(ctx, [none, none, none, none, none])))).toMatch(/2 to 4 options/);
    expect(reason(run(ctx, question(ctx, [none, none])))).toBe("ok");
    expect(reason(run(ctx, question(ctx, [none, none, none, none])))).toBe("ok");
  });

  it("rejects an option action outside the four", () => {
    const ctx = fixtureContext();
    const bad = { action: "send-mail", to: "attacker@evil.tld", label: "Verstuur" };
    expect(reason(run(ctx, question(ctx, [none, bad])))).toMatch(/action/);
  });

  it("rejects an option targeting a task not in context", () => {
    const ctx = fixtureContext();
    const opt = { action: "set-task-status", taskId: crypto.randomUUID(), status: "done", label: "Klaar" };
    expect(reason(run(ctx, question(ctx, [none, opt])))).toMatch(/task/);
  });

  it("rejects an option with a status the task cannot move to", () => {
    const ctx = fixtureContext();
    // waiting → open is not an edge; open → done is.
    const back = { action: "set-task-status", taskId: ctx.ids.waitingTask, status: "open", label: "Heropen" };
    expect(reason(run(ctx, question(ctx, [none, back])))).toMatch(/status/);
    const fine = { action: "set-task-status", taskId: ctx.ids.task, status: "done", label: "Klaar" };
    expect(reason(run(ctx, question(ctx, [none, fine])))).toBe("ok");
  });

  it("refuses a status option when the context does not know the task's status", () => {
    const ctx = fixtureContext();
    delete ctx.tasks[0].status;
    const opt = { action: "set-task-status", taskId: ctx.ids.task, status: "done", label: "Klaar" };
    expect(reason(run(ctx, question(ctx, [none, opt])))).toMatch(/status/);
  });

  it("rejects an option linking a debt not in context", () => {
    const ctx = fixtureContext();
    const bad = { action: "link-document-to-debt", documentId: ctx.ids.attachment,
      debtId: crypto.randomUUID(), label: "Koppel" };
    expect(reason(run(ctx, question(ctx, [none, bad])))).toMatch(/debt/);
    const badDoc = { action: "link-document-to-debt", documentId: ctx.ids.discarded,
      debtId: ctx.ids.debt, label: "Koppel" };
    expect(reason(run(ctx, question(ctx, [none, badDoc])))).toMatch(/document/);
    const fine = { action: "link-document-to-debt", documentId: ctx.ids.attachment,
      debtId: ctx.ids.debt, label: "Koppel" };
    expect(reason(run(ctx, question(ctx, [none, fine])))).toBe("ok");
  });

  it("a create-task option needs a title", () => {
    const ctx = fixtureContext();
    const bad = { action: "create-task", title: "", dueAt: null, label: "Taak" };
    expect(reason(run(ctx, question(ctx, [none, bad])))).toMatch(/title/);
  });

  it("keeps dueAt, missing, entrySummary and task in the payload", () => {
    const ctx = fixtureContext();
    const r = run(ctx, reply(ctx, {
      dueAt: "2026-11-07", missing: ["Loonstrook oktober"],
      task: { title: "Loonstrook oktober opvragen", dueAt: "2026-11-05" },
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      ask: "Loonstrook oktober aanleveren", dueAt: "2026-11-07", missing: ["Loonstrook oktober"],
      entrySummary: "Loonstrook september nogmaals gestuurd",
      task: { title: "Loonstrook oktober opvragen", dueAt: "2026-11-05" },
    });
    expect(r.payload.reliedOn).toEqual(r.reliedOn);
  });

  it("refuses a dueAt that is not a date", () => {
    const ctx = fixtureContext();
    expect(reason(run(ctx, reply(ctx, { dueAt: "volgende week" })))).toMatch(/dueAt/);
  });
});
