import { describe, expect, it } from "vitest";
import { handleMessage, type MessageContext } from "../src/conversation.js";
import { detectIntent } from "../src/intents.js";
import { emptyThread, type Thread } from "../src/types.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const owner = { phone: "+17025550100", name: "Myles", role: "owner" as const };
const requester = { phone: "+17025550101", name: "Friend", role: "requester" as const };

function ctx(over: Partial<MessageContext> & { thread?: Partial<Thread> } = {}): MessageContext {
  const { thread, ...rest } = over;
  return {
    sender: owner,
    text: "hello",
    lastShipped: null,
    now: NOW,
    ttlMinutes: 60,
    ...rest,
    thread: { ...emptyThread(owner.phone, NOW), ...thread },
  };
}

describe("detectIntent", () => {
  it.each([
    ["Ship it!", "ship"],
    ["ship it", "ship"],
    ["YES", "yes"],
    ["ok.", "yes"],
    ["nope", "no"],
    ["Cancel", "cancel"],
    ["undo", "undo"],
    ["undo the last change", "undo"],
    ["status", "status"],
    ["update the headline to say yes", "text"],
  ])("%s → %s", (text, intent) => {
    expect(detectIntent(text)).toBe(intent);
  });
});

describe("handleMessage", () => {
  it("starts planning a new request and replies right away", () => {
    const out = handleMessage(ctx({ text: "update the headline to say Hi" }));
    expect(out.reply).toBe("On it.");
    expect(out.thread.state).toBe("planning");
    expect(out.thread.gen).toBe(1);
    expect(out.jobs).toEqual([{ kind: "plan", phone: owner.phone, gen: 1 }]);
  });

  it("tells you it's busy while a job runs", () => {
    const out = handleMessage(ctx({ text: "another thing", thread: { state: "working", gen: 3 } }));
    expect(out.reply).toMatch(/Still on it/);
    expect(out.jobs).toHaveLength(0);
    expect(out.thread.state).toBe("working");
  });

  it("feeds a clarifying answer back to the planner", () => {
    const out = handleMessage(
      ctx({ text: "the big one", thread: { state: "clarifying", gen: 2, history: [{ from: "me", text: "x" }] } }),
    );
    expect(out.thread.state).toBe("planning");
    expect(out.thread.history.at(-1)).toEqual({ from: "me", text: "the big one" });
    expect(out.jobs[0]).toMatchObject({ kind: "plan", gen: 2 });
  });

  it("implements only after yes", () => {
    const plan = { summary: "Changing the headline to 'Hi'", details: "…" };
    const yes = handleMessage(ctx({ text: "yes", thread: { state: "confirming", gen: 2, plan } }));
    expect(yes.thread.state).toBe("working");
    expect(yes.jobs[0]).toMatchObject({ kind: "implement" });

    const no = handleMessage(ctx({ text: "no", thread: { state: "confirming", gen: 2, plan } }));
    expect(no.thread.state).toBe("clarifying");
    expect(no.thread.plan).toBeNull();
    expect(no.jobs).toHaveLength(0);
  });

  it("treats other text during confirmation as a revision", () => {
    const plan = { summary: "Changing the headline", details: "…" };
    const out = handleMessage(ctx({ text: "actually make it shorter", thread: { state: "confirming", plan } }));
    expect(out.thread.state).toBe("planning");
    expect(out.jobs[0]?.kind).toBe("plan");
  });

  it("only ships on 'ship it' and only for the owner", () => {
    const base = { state: "reviewing" as const, prNumber: 7, previewUrl: "https://p.onrender.com" };
    expect(handleMessage(ctx({ text: "looks fine", thread: base })).jobs).toHaveLength(0);
    const ship = handleMessage(ctx({ text: "ship it", thread: base }));
    expect(ship.thread.state).toBe("shipping");
    expect(ship.jobs[0]?.kind).toBe("ship");

    const denied = handleMessage(ctx({ sender: requester, text: "ship it", thread: base }));
    expect(denied.jobs).toHaveLength(0);
    expect(denied.reply).toMatch(/Only the site owner/);
  });

  it("cancel closes the open PR and bumps the generation", () => {
    const out = handleMessage(
      ctx({ text: "cancel", thread: { state: "reviewing", gen: 4, prNumber: 9, branch: "bot/x" } }),
    );
    expect(out.thread.state).toBe("idle");
    expect(out.thread.gen).toBe(5);
    expect(out.jobs).toEqual([
      { kind: "close_pr", phone: owner.phone, gen: 4, payload: { prNumber: 9, branch: "bot/x" } },
    ]);
  });

  it("cancel during a background job discards it via the generation", () => {
    const out = handleMessage(ctx({ text: "cancel", thread: { state: "planning", gen: 4 } }));
    expect(out.thread).toMatchObject({ state: "idle", gen: 5 });
  });

  it("won't cancel mid-merge", () => {
    const out = handleMessage(ctx({ text: "cancel", thread: { state: "shipping", gen: 4 } }));
    expect(out.thread.state).toBe("shipping");
    expect(out.reply).toMatch(/Too late/);
  });

  it("undo asks for confirmation, then reverts", () => {
    const lastShipped = { prNumber: 12, title: "Changing the headline", mergeSha: "abc", phone: owner.phone };
    const ask = handleMessage(ctx({ text: "undo", lastShipped }));
    expect(ask.thread).toMatchObject({ state: "confirming_undo", undoPrNumber: 12 });
    expect(ask.reply).toContain("#12");

    const go = handleMessage(ctx({ text: "yes", thread: ask.thread }));
    expect(go.thread.state).toBe("undoing");
    expect(go.jobs[0]).toMatchObject({ kind: "undo", payload: { prNumber: 12 } });
  });

  it("undo with nothing shipped says so", () => {
    expect(handleMessage(ctx({ text: "undo" })).reply).toMatch(/haven't shipped/);
  });

  it("expires a stale thread and closes its preview PR", () => {
    const old = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
    const out = handleMessage(
      ctx({
        text: "update the footer",
        thread: { state: "reviewing", gen: 1, prNumber: 3, branch: "bot/y", updatedAt: old },
      }),
    );
    expect(out.reply).toMatch(/expired/);
    expect(out.jobs.map((j) => j.kind)).toEqual(["close_pr", "plan"]);
    expect(out.thread.state).toBe("planning");
  });

  it("does not expire a running job", () => {
    const old = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
    const out = handleMessage(ctx({ text: "hi", thread: { state: "working", updatedAt: old } }));
    expect(out.reply).toMatch(/Still on it/);
  });
});
