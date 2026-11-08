export type Role = "owner" | "requester";

export interface AllowedSender {
  phone: string;
  name: string;
  role: Role;
}

export type ThreadState =
  | "idle"
  | "planning" // background job is working out what to change
  | "clarifying" // waiting for an answer to a clarifying question
  | "confirming" // waiting for yes/no on the planned change
  | "working" // background job is editing, checking and opening the PR
  | "reviewing" // preview is up, waiting for "ship it"
  | "shipping" // background job is merging
  | "confirming_undo" // waiting for yes/no on a revert
  | "undoing"; // background job is reverting

export const BUSY_STATES: readonly ThreadState[] = ["planning", "working", "shipping", "undoing"];

export interface Turn {
  from: "me" | "bot";
  text: string;
}

export interface Plan {
  /** One line read back to Myles, e.g. "Changing the hero headline to 'X'". */
  summary: string;
  /** Detailed instructions for the implementing agent. */
  details: string;
}

export interface Thread {
  phone: string;
  state: ThreadState;
  /** Bumped on every new request or cancel; background jobs from an older generation are discarded. */
  gen: number;
  history: Turn[];
  plan: Plan | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  previewUrl: string | null;
  undoPrNumber: number | null;
  updatedAt: string;
}

export interface ShippedChange {
  prNumber: number;
  title: string;
  mergeSha: string;
  phone: string;
}

export type JobKind = "plan" | "implement" | "ship" | "undo" | "close_pr";

export interface JobRequest {
  kind: JobKind;
  phone: string;
  gen: number;
  /** Extra data, e.g. the PR to close. */
  payload?: Record<string, unknown>;
}

export function emptyThread(phone: string, now: Date): Thread {
  return {
    phone,
    state: "idle",
    gen: 0,
    history: [],
    plan: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    previewUrl: null,
    undoPrNumber: null,
    updatedAt: now.toISOString(),
  };
}
