import { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";

const RENDER_URL = /https:\/\/[a-z0-9.-]+\.onrender\.com[^\s)"'<>]*/i;

export class GitHub {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private base: string;

  constructor(
    cfg: Config["github"],
    private previewUrlTemplate?: string,
  ) {
    this.octokit = new Octokit({ auth: cfg.token });
    this.owner = cfg.owner;
    this.repo = cfg.repo;
    this.base = cfg.baseBranch;
  }

  private get r() {
    return { owner: this.owner, repo: this.repo };
  }

  async openPr(branch: string, title: string, body: string): Promise<{ number: number; url: string; sha: string }> {
    const { data } = await this.octokit.pulls.create({ ...this.r, head: branch, base: this.base, title, body });
    return { number: data.number, url: data.html_url, sha: data.head.sha };
  }

  async getPr(prNumber: number): Promise<{ title: string; state: string; merged: boolean }> {
    const { data } = await this.octokit.pulls.get({ ...this.r, pull_number: prNumber });
    return { title: data.title, state: data.state, merged: data.merged };
  }

  async mergePr(prNumber: number): Promise<string> {
    const { data } = await this.octokit.pulls.merge({ ...this.r, pull_number: prNumber, merge_method: "squash" });
    return data.sha;
  }

  async closePr(prNumber: number, branch: string | null): Promise<void> {
    await this.octokit.pulls.update({ ...this.r, pull_number: prNumber, state: "closed" });
    if (branch) await this.deleteBranch(branch);
  }

  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.octokit.git.deleteRef({ ...this.r, ref: `heads/${branch}` });
    } catch {
      // Already gone (e.g. auto-deleted on merge).
    }
  }

  /**
   * Find the Render preview URL for a PR: a GitHub deployment status for the head
   * commit, or a Render bot comment on the PR. Returns null if neither exists yet.
   */
  async findPreviewUrl(prNumber: number, sha: string): Promise<string | null> {
    const { data: deployments } = await this.octokit.repos.listDeployments({ ...this.r, sha, per_page: 10 });
    for (const d of deployments) {
      const { data: statuses } = await this.octokit.repos.listDeploymentStatuses({
        ...this.r,
        deployment_id: d.id,
        per_page: 10,
      });
      const live = statuses.find((s) => s.state === "success" && (s.environment_url || s.target_url));
      if (live) return live.environment_url || live.target_url || null;
    }
    const { data: comments } = await this.octokit.issues.listComments({ ...this.r, issue_number: prNumber });
    for (const c of comments.reverse()) {
      const match = c.body?.match(RENDER_URL);
      if (match) return match[0];
    }
    return null;
  }

  async waitForPreviewUrl(
    prNumber: number,
    sha: string,
    opts: { timeoutMs?: number; intervalMs?: number; isCancelled?: () => Promise<boolean> } = {},
  ): Promise<string | null> {
    const deadline = Date.now() + (opts.timeoutMs ?? 12 * 60_000);
    while (Date.now() < deadline) {
      const url = await this.findPreviewUrl(prNumber, sha).catch(() => null);
      if (url) return url;
      if (opts.isCancelled && (await opts.isCancelled())) return null;
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 20_000));
    }
    return this.previewUrlTemplate ? this.previewUrlTemplate.replace("{pr}", String(prNumber)) : null;
  }
}
