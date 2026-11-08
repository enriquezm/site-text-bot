import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Plan, Turn } from "./types.js";

export type PlannerResult = { action: "ask"; question: string } | { action: "plan"; plan: Plan };

export interface Agent {
  plan(cwd: string, history: Turn[]): Promise<PlannerResult>;
  implement(cwd: string, plan: Plan, fixFor?: string): Promise<void>;
}

const SITE_CONTEXT = `You are working on Myles Enriquez's personal portfolio site (Nuxt 4, Vue 3, TypeScript, Tailwind v4).
Content lives in app/data/site.ts; components are in app/components; design tokens are in app/assets/css/main.css.
Read DESIGN_SPEC.md for design rules. CLAUDE.md describes the original build; its workflow steps (plan first and wait for OK, commit after each step) do NOT apply here.
Myles sends change requests by text message from his phone, so requests are short and informal.`;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["ask", "plan"] },
    question: { type: "string", description: "When action is ask: one short clarifying question, under 200 characters." },
    summary: {
      type: "string",
      description:
        "When action is plan: one line read back to Myles by text, under 200 characters, e.g. \"Changing the hero headline to 'Design engineer building with AI'\".",
    },
    details: {
      type: "string",
      description: "When action is plan: exact files, current values and new values for the implementing agent.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

function transcript(history: Turn[]): string {
  return history.map((t) => `${t.from === "me" ? "Myles" : "Bot"}: ${t.text}`).join("\n");
}

async function runToResult(prompt: string, options: Options): Promise<Extract<SDKResultMessage, { subtype: "success" }>> {
  let result: SDKResultMessage | undefined;
  for await (const message of query({ prompt, options })) {
    if (message.type === "result") result = message;
  }
  if (!result) throw new Error("Claude Code ended without a result");
  if (result.subtype !== "success" || result.is_error) {
    throw new Error(`Claude Code failed: ${result.subtype}`);
  }
  return result;
}

export class ClaudeCodeAgent implements Agent {
  constructor(private model?: string) {}

  private base(cwd: string): Options {
    return {
      cwd,
      ...(this.model ? { model: this.model } : {}),
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code", append: SITE_CONTEXT },
      permissionMode: "dontAsk",
    };
  }

  async plan(cwd: string, history: Turn[]): Promise<PlannerResult> {
    const prompt = `Here is the text conversation so far:

${transcript(history)}

Find exactly what in the repo Myles wants changed. Do not edit anything.
- If the request is ambiguous (which element, what exact wording, which of several matches), choose action "ask" with one short question.
- Otherwise choose action "plan": a one-line summary that quotes the new text where there is any, plus precise details for the implementer.
- If the request is not a change to this site, choose "ask" and say what you can help with.`;

    const result = await runToResult(prompt, {
      ...this.base(cwd),
      allowedTools: ["Read", "Grep", "Glob"],
      maxTurns: 25,
      outputFormat: { type: "json_schema", schema: PLAN_SCHEMA },
    });

    const out = result.structured_output as
      | { action: "ask" | "plan"; question?: string; summary?: string; details?: string }
      | undefined;
    if (!out) throw new Error("Planner returned no structured output");
    if (out.action === "plan" && out.summary) {
      return { action: "plan", plan: { summary: out.summary, details: out.details ?? out.summary } };
    }
    return { action: "ask", question: out.question ?? "Can you say a bit more about what to change?" };
  }

  async implement(cwd: string, plan: Plan, fixFor?: string): Promise<void> {
    const prompt = fixFor
      ? `You made this change: ${plan.summary}

The site checks then failed. Fix the failure without changing the intent of the edit:

${fixFor}`
      : `Make this change to the site, and nothing else:

${plan.summary}

Details:
${plan.details}

Keep the edit minimal and match the existing code style. You may run npm run lint, npm run typecheck and npm run build to check your work. Do not commit.`;

    await runToResult(prompt, {
      ...this.base(cwd),
      allowedTools: [
        "Read",
        "Grep",
        "Glob",
        "Edit",
        "Write",
        "Bash(npm run lint)",
        "Bash(npm run lint:*)",
        "Bash(npm run typecheck)",
        "Bash(npm run build)",
      ],
      maxTurns: 40,
    });
  }
}
