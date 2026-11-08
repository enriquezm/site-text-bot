import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import { mustRun, run, tail } from "./shell.js";

/** A fresh clone of the site repo in a temp directory, removed by `dispose()`. */
export class Workspace {
  private constructor(
    readonly dir: string,
    private cfg: Config["github"],
  ) {}

  static async clone(cfg: Config["github"], opts: { depth?: number } = {}): Promise<Workspace> {
    const parent = await mkdtemp(join(tmpdir(), "site-bot-"));
    const dir = join(parent, "repo");
    const url = `https://x-access-token:${cfg.token}@github.com/${cfg.owner}/${cfg.repo}.git`;
    const depthArgs = opts.depth ? ["--depth", String(opts.depth)] : [];
    await mustRun("git", ["clone", ...depthArgs, "--branch", cfg.baseBranch, url, dir]);
    await mustRun("git", ["config", "user.name", "Site Text Bot"], { cwd: dir });
    await mustRun("git", ["config", "user.email", "site-text-bot@users.noreply.github.com"], { cwd: dir });
    return new Workspace(dir, cfg);
  }

  git(...args: string[]): Promise<string> {
    return mustRun("git", args, { cwd: this.dir });
  }

  async hasChanges(): Promise<boolean> {
    return (await this.git("status", "--porcelain")).trim().length > 0;
  }

  async changedFiles(): Promise<string[]> {
    const out = await this.git("status", "--porcelain");
    return out
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  }

  async commitAll(branch: string, message: string): Promise<void> {
    await this.git("checkout", "-b", branch);
    await this.git("add", "-A");
    await this.git("commit", "-m", message);
    await this.git("push", "-u", "origin", branch);
  }

  async revert(sha: string, branch: string): Promise<void> {
    await this.git("checkout", "-b", branch);
    await this.git("revert", "--no-edit", sha);
    await this.git("push", "-u", "origin", branch);
  }

  async dispose(): Promise<void> {
    await rm(join(this.dir, ".."), { recursive: true, force: true });
  }

  get repoSlug(): string {
    return `${this.cfg.owner}/${this.cfg.repo}`;
  }
}

export interface CheckResult {
  ok: boolean;
  failedStep?: string;
  output?: string;
}

/** The site has no test suite, so "tests" = install, lint, typecheck, build. */
export const CHECK_STEPS: [string, string[]][] = [
  ["lint", ["run", "lint"]],
  ["typecheck", ["run", "typecheck"]],
  ["build", ["run", "build"]],
];

export async function installDeps(dir: string): Promise<void> {
  await mustRun("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 15 * 60_000 });
}

export async function runChecks(dir: string): Promise<CheckResult> {
  for (const [name, args] of CHECK_STEPS) {
    const r = await run("npm", args, { cwd: dir, timeoutMs: 15 * 60_000 });
    if (!r.ok) return { ok: false, failedStep: name, output: tail(r.output, 6000) };
  }
  return { ok: true };
}

/** A few lines of a failed check, short enough for a text message. */
export function shortError(check: CheckResult): string {
  const lines = (check.output ?? "")
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => /error|✖|failed|cannot|expected/i.test(l));
  const body = (lines.length ? lines.slice(0, 3) : ["(no error lines found)"]).join("\n");
  return `${check.failedStep} failed:\n${body}`.slice(0, 320);
}
