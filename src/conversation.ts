import { detectIntent } from "./intents.js";
import {
  BUSY_STATES,
  emptyThread,
  type AllowedSender,
  type JobRequest,
  type ShippedChange,
  type Thread,
} from "./types.js";

export interface MessageContext {
  sender: AllowedSender;
  thread: Thread;
  text: string;
  lastShipped: ShippedChange | null;
  now: Date;
  ttlMinutes: number;
}

export interface MessageOutcome {
  reply: string | null;
  thread: Thread;
  jobs: JobRequest[];
}

export const HELP_TEXT = [
  "Text me a change for the site, e.g. \"update the headline to say X\".",
  "I'll confirm the plan, then send a preview link.",
  "Commands: ship it, cancel, undo, status, help.",
].join("\n");

function describeState(t: Thread): string {
  switch (t.state) {
    case "idle":
      return "Nothing in progress. Text me a change for the site.";
    case "planning":
      return "Working out what to change.";
    case "clarifying":
      return `Waiting on your answer: ${lastBotTurn(t) ?? "(see my last text)"}`;
    case "confirming":
      return `Waiting for yes/no on: ${t.plan?.summary ?? "the planned change"}`;
    case "working":
      return "Making the change and running checks.";
    case "reviewing":
      return `Preview is up: ${t.previewUrl ?? t.prUrl ?? "(link pending)"}\nReply "ship it" to deploy or "cancel".`;
    case "shipping":
      return "Merging and deploying now.";
    case "confirming_undo":
      return `Waiting for yes/no on reverting #${t.undoPrNumber}.`;
    case "undoing":
      return "Reverting the last change.";
  }
}

function lastBotTurn(t: Thread): string | undefined {
  return [...t.history].reverse().find((h) => h.from === "bot")?.text;
}

function isExpired(t: Thread, now: Date, ttlMinutes: number): boolean {
  if (t.state === "idle" || BUSY_STATES.includes(t.state)) return false;
  return now.getTime() - new Date(t.updatedAt).getTime() > ttlMinutes * 60_000;
}

/**
 * Decide what to do with one incoming text. Pure: no I/O. The caller saves the
 * returned thread, sends the reply and enqueues the jobs.
 */
export function handleMessage(ctx: MessageContext): MessageOutcome {
  const { sender, text, now } = ctx;
  let thread: Thread = { ...ctx.thread, updatedAt: now.toISOString() };
  const jobs: JobRequest[] = [];
  let prefix = "";

  const job = (kind: JobRequest["kind"], payload?: Record<string, unknown>) =>
    jobs.push({ kind, phone: thread.phone, gen: thread.gen, ...(payload ? { payload } : {}) });

  const reset = (): Thread => ({ ...emptyThread(thread.phone, now), gen: thread.gen + 1 });

  const out = (reply: string | null): MessageOutcome => ({
    reply: reply === null ? null : prefix + reply,
    thread,
    jobs,
  });

  if (isExpired(ctx.thread, now, ctx.ttlMinutes)) {
    if (ctx.thread.prNumber && ctx.thread.state === "reviewing") {
      job("close_pr", { prNumber: ctx.thread.prNumber, branch: ctx.thread.branch });
    }
    thread = reset();
    prefix = "(Your last request expired, so I dropped it.)\n";
  }

  const intent = detectIntent(text);
  const isOwner = sender.role === "owner";

  if (intent === "help") return out(HELP_TEXT);
  if (intent === "status") return out(describeState(thread));

  if (intent === "cancel") {
    if (thread.state === "idle") return out("Nothing to cancel.");
    if (thread.state === "shipping" || thread.state === "undoing") {
      return out("Too late to cancel, it's already merging. Text \"undo\" once it's done.");
    }
    if (thread.prNumber) job("close_pr", { prNumber: thread.prNumber, branch: thread.branch });
    thread = reset();
    return out("Cancelled. Nothing was deployed.");
  }

  if (BUSY_STATES.includes(thread.state)) {
    return out(`Still on it: ${describeState(thread)} Text "cancel" to drop it.`);
  }

  switch (thread.state) {
    case "idle": {
      if (intent === "undo") {
        if (!isOwner) return out("Only the site owner can undo changes.");
        if (!ctx.lastShipped) return out("I haven't shipped anything I can undo yet.");
        thread = { ...thread, state: "confirming_undo", undoPrNumber: ctx.lastShipped.prNumber };
        return out(`Revert "${ctx.lastShipped.title}" (#${ctx.lastShipped.prNumber})? Reply yes or no.`);
      }
      if (intent === "yes" || intent === "no" || intent === "ship") {
        return out("Nothing is waiting on you. Text me a change for the site.");
      }
      thread = {
        ...reset(),
        state: "planning",
        history: [{ from: "me", text }],
      };
      job("plan");
      return out("On it.");
    }

    case "clarifying": {
      thread = { ...thread, state: "planning", history: [...thread.history, { from: "me", text }] };
      job("plan");
      return out("Got it.");
    }

    case "confirming": {
      if (intent === "yes") {
        thread = { ...thread, state: "working" };
        job("implement");
        return out("Making the change now. I'll text you a preview link.");
      }
      if (intent === "no") {
        const ask = "Okay. What should change instead?";
        thread = {
          ...thread,
          state: "clarifying",
          plan: null,
          history: [...thread.history, { from: "me", text }, { from: "bot", text: ask }],
        };
        return out(ask);
      }
      // Anything else is a revision of the request.
      thread = {
        ...thread,
        state: "planning",
        plan: null,
        history: [...thread.history, { from: "me", text }],
      };
      job("plan");
      return out("Got it, updating the plan.");
    }

    case "reviewing": {
      if (intent === "ship") {
        if (!isOwner) return out("Only the site owner can ship. I've left the preview up for them.");
        thread = { ...thread, state: "shipping" };
        job("ship");
        return out("Shipping it.");
      }
      return out(`Reply "ship it" to deploy, or "cancel" to drop it.\nPreview: ${thread.previewUrl ?? thread.prUrl}`);
    }

    case "confirming_undo": {
      if (intent === "yes") {
        thread = { ...thread, state: "undoing" };
        job("undo", { prNumber: thread.undoPrNumber });
        return out("Reverting it now.");
      }
      if (intent === "no") {
        thread = reset();
        return out("Okay, leaving it as is.");
      }
      return out(`Reply yes to revert #${thread.undoPrNumber}, or no to keep it.`);
    }

    default:
      return out(describeState(thread));
  }
}
