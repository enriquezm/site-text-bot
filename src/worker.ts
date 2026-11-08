import type { Agent } from "./claude.js";
import type { GitHub } from "./github.js";
import { redact } from "./shell.js";
import type { Sms } from "./sms.js";
import type { Store, StoredJob } from "./store.js";
import { emptyThread, type Thread } from "./types.js";
import type { CheckResult, Workspace } from "./workspace.js";
import { shortError } from "./workspace.js";

export type WorkspaceLike = Pick<Workspace, "dir" | "hasChanges" | "changedFiles" | "commitAll" | "revert" | "dispose">;

export interface WorkerDeps {
  store: Store;
  sms: Sms;
  agent: Agent;
  github: Pick<GitHub, "openPr" | "mergePr" | "closePr" | "deleteBranch" | "getPr" | "waitForPreviewUrl">;
  openWorkspace(opts?: { depth?: number }): Promise<WorkspaceLike>;
  installDeps(dir: string): Promise<void>;
  runChecks(dir: string): Promise<CheckResult>;
  now?: () => Date;
}

class Stale extends Error {}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "change"
  );
}

export class Worker {
  constructor(private d: WorkerDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** Load the thread and make sure this job still belongs to it. */
  private async current(job: StoredJob): Promise<Thread> {
    const t = await this.d.store.getThread(job.phone);
    if (t.gen !== job.gen) throw new Stale();
    return t;
  }

  private async save(t: Thread, reply?: string): Promise<void> {
    const history = reply ? [...t.history, { from: "bot" as const, text: reply }] : t.history;
    await this.d.store.saveThread({ ...t, history, updatedAt: this.now().toISOString() });
    if (reply) await this.d.sms.send(t.phone, reply);
  }

  private async resetWith(t: Thread, reply: string): Promise<void> {
    await this.d.store.saveThread({ ...emptyThread(t.phone, this.now()), gen: t.gen + 1 });
    await this.d.sms.send(t.phone, reply);
  }

  async run(job: StoredJob): Promise<"done" | "discarded"> {
    try {
      switch (job.kind) {
        case "plan":
          await this.plan(job);
          break;
        case "implement":
          await this.implement(job);
          break;
        case "ship":
          await this.ship(job);
          break;
        case "undo":
          await this.undo(job);
          break;
        case "close_pr":
          await this.d.github.closePr(job.payload?.prNumber as number, (job.payload?.branch as string) ?? null);
          break;
      }
      return "done";
    } catch (err) {
      if (err instanceof Stale) return "discarded";
      // Tell Myles, unless the request was cancelled meanwhile.
      const t = await this.d.store.getThread(job.phone);
      if (t.gen === job.gen && job.kind !== "close_pr") {
        const msg = err instanceof Error ? err.message : String(err);
        await this.resetWith(t, `Something went wrong (${job.kind}): ${redact(msg).slice(0, 200)}`);
      }
      throw err;
    }
  }

  private async plan(job: StoredJob): Promise<void> {
    const t = await this.current(job);
    const ws = await this.d.openWorkspace({ depth: 1 });
    try {
      const result = await this.d.agent.plan(ws.dir, t.history);
      const fresh = await this.current(job);
      if (result.action === "ask") {
        await this.save({ ...fresh, state: "clarifying" }, result.question);
      } else {
        await this.save(
          { ...fresh, state: "confirming", plan: result.plan },
          `${result.plan.summary}. Okay? (yes / no)`,
        );
      }
    } finally {
      await ws.dispose();
    }
  }

  private async implement(job: StoredJob): Promise<void> {
    const t = await this.current(job);
    if (!t.plan) throw new Error("no plan to implement");
    const plan = t.plan;
    const ws = await this.d.openWorkspace();
    try {
      await this.d.installDeps(ws.dir);
      await this.d.agent.implement(ws.dir, plan);
      await this.current(job);

      let check = await this.d.runChecks(ws.dir);
      if (!check.ok) {
        // One retry: hand the failure back to Claude Code.
        await this.d.agent.implement(ws.dir, plan, check.output);
        await this.current(job);
        check = await this.d.runChecks(ws.dir);
      }
      if (!check.ok) {
        await this.resetWith(t, `Checks still failing after a retry, so I dropped the change.\n${shortError(check)}`);
        return;
      }
      if (!(await ws.hasChanges())) {
        await this.resetWith(t, "I couldn't find anything to change for that, so nothing was done.");
        return;
      }

      const files = await ws.changedFiles();
      const stamp = this.now().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const branch = `bot/${stamp}-${slug(plan.summary)}`;
      await ws.commitAll(branch, `${plan.summary}\n\nRequested by text message.`);

      const body = [
        `Requested by text: ${t.history.find((h) => h.from === "me")?.text ?? ""}`,
        "",
        `**Plan:** ${plan.summary}`,
        "",
        "**Files:**",
        ...files.map((f) => `- \`${f}\``),
        "",
        "Lint, typecheck and build passed. Merges when Myles replies \"ship it\".",
      ].join("\n");
      const pr = await this.d.github.openPr(branch, plan.summary.slice(0, 120), body);

      // Save the PR right away so a cancel during the preview wait can close it.
      let latest: Thread;
      try {
        latest = await this.current(job);
      } catch (err) {
        await this.d.github.closePr(pr.number, branch); // cancelled while the PR was opening
        throw err;
      }
      await this.save({ ...latest, branch, prNumber: pr.number, prUrl: pr.url });

      const preview = await this.d.github.waitForPreviewUrl(pr.number, pr.sha, {
        isCancelled: async () => (await this.d.store.getThread(job.phone)).gen !== job.gen,
      });
      const fresh = await this.current(job);
      const link = preview ?? pr.url;
      await this.save(
        { ...fresh, state: "reviewing", previewUrl: preview },
        `${preview ? "Preview" : "No preview link yet; here's the PR"}: ${link}\nReply "ship it" to deploy, or "cancel".`,
      );
    } finally {
      await ws.dispose();
    }
  }

  private async ship(job: StoredJob): Promise<void> {
    const t = await this.current(job);
    if (!t.prNumber) throw new Error("no pull request to ship");
    const sha = await this.d.github.mergePr(t.prNumber);
    if (t.branch) await this.d.github.deleteBranch(t.branch);
    await this.d.store.recordShipped({
      prNumber: t.prNumber,
      title: t.plan?.summary ?? `PR #${t.prNumber}`,
      mergeSha: sha,
      phone: t.phone,
    });
    await this.resetWith(t, `Shipped. Render is deploying it to production now. Text "undo" to revert.`);
  }

  private async undo(job: StoredJob): Promise<void> {
    const t = await this.current(job);
    const target = await this.d.store.lastShipped();
    if (!target || target.prNumber !== t.undoPrNumber) {
      await this.resetWith(t, "That change has already been reverted or replaced, so I left things alone.");
      return;
    }
    const ws = await this.d.openWorkspace();
    try {
      const branch = `bot/revert-${target.prNumber}`;
      await ws.revert(target.mergeSha, branch);
      const pr = await this.d.github.openPr(
        branch,
        `Revert: ${target.title}`.slice(0, 120),
        `Reverts #${target.prNumber}, requested by text.`,
      );
      await this.d.github.mergePr(pr.number);
      await this.d.github.deleteBranch(branch);
      await this.d.store.markReverted(target.prNumber);
      await this.resetWith(t, `Reverted "${target.title}". Render is redeploying production.`);
    } finally {
      await ws.dispose();
    }
  }
}
