import { describe, expect, it } from "vitest";
import type { Agent, PlannerResult } from "../src/claude.js";
import { JobQueue } from "../src/queue.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import type { CheckResult } from "../src/workspace.js";
import { Worker, type WorkerDeps, type WorkspaceLike } from "../src/worker.js";

const OWNER = "+17025550100";

function harness(opts: { planner?: PlannerResult[]; checks?: CheckResult[]; changes?: boolean } = {}) {
  const store = new MemoryStore();
  store.senders.set(OWNER, { phone: OWNER, name: "Myles", role: "owner" });
  const texts: string[] = [];
  const calls: string[] = [];
  const planner = [...(opts.planner ?? [{ action: "plan", plan: { summary: "Changing the hero headline to 'Hi'", details: "app/data/site.ts" } }])] as PlannerResult[];
  const checks = [...(opts.checks ?? [{ ok: true }])];
  let prCount = 100;

  const agent: Agent = {
    async plan() {
      calls.push("plan");
      return planner.shift() ?? { action: "ask", question: "?" };
    },
    async implement(_dir, _plan, fixFor) {
      calls.push(fixFor ? "fix" : "implement");
    },
  };
  const workspace = (): WorkspaceLike => ({
    dir: "/tmp/fake",
    hasChanges: async () => opts.changes ?? true,
    changedFiles: async () => ["app/data/site.ts"],
    commitAll: async (branch) => void calls.push(`commit ${branch}`),
    revert: async (sha) => void calls.push(`revert ${sha}`),
    dispose: async () => {},
  });
  const deps: WorkerDeps = {
    store,
    sms: { send: async (_to, body) => void texts.push(body) },
    agent,
    github: {
      openPr: async () => ({ number: ++prCount, url: `https://github.com/pr/${prCount}`, sha: `sha${prCount}` }),
      mergePr: async (n) => (calls.push(`merge ${n}`), `merged${n}`),
      closePr: async (n) => void calls.push(`close ${n}`),
      deleteBranch: async () => {},
      getPr: async () => ({ title: "", state: "open", merged: false }),
      waitForPreviewUrl: async (n) => `https://site-pr-${n}.onrender.com`,
    },
    openWorkspace: async () => workspace(),
    installDeps: async () => {},
    runChecks: async () => checks.shift() ?? { ok: true },
  };
  const queue = new JobQueue(store, new Worker(deps), () => {});
  const app = buildServer({
    store,
    queue,
    twilioAuthToken: "x",
    publicUrl: "https://bot",
    threadTtlMinutes: 60,
    skipSignatureCheck: true,
  });

  async function text(body: string): Promise<string | null> {
    const res = await app.inject({
      method: "POST",
      url: "/sms",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ From: OWNER, Body: body }).toString(),
    });
    await queue.idle();
    const raw = res.body.match(/<Message>([\s\S]*)<\/Message>/)?.[1];
    if (raw === undefined) return null;
    const entities: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" };
    return raw.replace(/&(lt|gt|quot|apos|amp);/g, (e) => entities[e]!);
  }
  return { store, texts, calls, text };
}

describe("text flow", () => {
  it("request → confirm → preview → ship → undo", async () => {
    const h = harness();
    expect(await h.text("update the headline to say Hi")).toBe("On it.");
    expect(h.texts.at(-1)).toBe("Changing the hero headline to 'Hi'. Okay? (yes / no)");
    expect(h.calls).toEqual(["plan"]); // nothing written before confirmation

    await h.text("yes");
    expect(h.calls.slice(1, 3)).toEqual(["implement", expect.stringMatching(/^commit bot\/\d+-changing-the-hero-headline/)]);
    expect(h.texts.at(-1)).toContain("Preview: https://site-pr-101.onrender.com");
    expect(h.calls).not.toContain("merge 101"); // nothing ships before "ship it"

    await h.text("ship it");
    expect(h.calls).toContain("merge 101");
    expect(h.texts.at(-1)).toMatch(/^Shipped/);
    expect((await h.store.getThread(OWNER)).state).toBe("idle");

    expect(await h.text("undo")).toMatch(/Revert "Changing the hero headline to 'Hi'" \(#101\)/);
    await h.text("yes");
    expect(h.calls).toContain("revert merged101");
    expect(h.calls).toContain("merge 102");
    expect(h.texts.at(-1)).toMatch(/^Reverted/);
    expect(await h.text("undo")).toMatch(/haven't shipped/);
  });

  it("asks a clarifying question, then plans with the answer", async () => {
    const h = harness({
      planner: [
        { action: "ask", question: "Which headline, the hero or the footer?" },
        { action: "plan", plan: { summary: "Changing the hero headline to 'Hi'", details: "" } },
      ],
    });
    await h.text("change the headline");
    expect(h.texts.at(-1)).toBe("Which headline, the hero or the footer?");
    await h.text("the hero");
    expect(h.texts.at(-1)).toMatch(/Okay\? \(yes \/ no\)$/);
    const t = await h.store.getThread(OWNER);
    const texts = t.history.map((x) => `${x.from}: ${x.text}`);
    expect(texts).toContain("me: change the headline");
    expect(texts).toContain("bot: Which headline, the hero or the footer?");
    expect(texts).toContain("me: the hero");
  });

  it("retries failed checks once, then gives up and texts the error", async () => {
    const fail: CheckResult = { ok: false, failedStep: "typecheck", output: "app/x.vue: error TS2322: bad type" };
    const h = harness({ checks: [fail, fail] });
    await h.text("update the headline");
    await h.text("yes");
    expect(h.calls).toEqual(["plan", "implement", "fix"]);
    expect(h.texts.at(-1)).toMatch(/Checks still failing after a retry[\s\S]*typecheck failed:[\s\S]*TS2322/);
    expect((await h.store.getThread(OWNER)).state).toBe("idle");
  });

  it("succeeds when the retry fixes the checks", async () => {
    const h = harness({ checks: [{ ok: false, failedStep: "lint", output: "error x" }, { ok: true }] });
    await h.text("update the headline");
    await h.text("yes");
    expect(h.texts.at(-1)).toContain("Preview:");
  });

  it("cancel during review closes the PR", async () => {
    const h = harness();
    await h.text("update the headline");
    await h.text("yes");
    expect(await h.text("cancel")).toMatch(/Cancelled/);
    expect(h.calls).toContain("close 101");
    expect(h.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("says so when the change produced no diff", async () => {
    const h = harness({ changes: false });
    await h.text("update the headline");
    await h.text("yes");
    expect(h.texts.at(-1)).toMatch(/couldn't find anything to change/);
  });
});
