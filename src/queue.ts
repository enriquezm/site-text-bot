import type { Store } from "./store.js";
import type { JobRequest } from "./types.js";
import type { Worker } from "./worker.js";

/**
 * In-process job queue: one job at a time, every job recorded in the database so a
 * restart can tell Myles what was interrupted.
 */
export class JobQueue {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private store: Store,
    private worker: Worker,
    private log: (msg: string, err?: unknown) => void = console.log,
  ) {}

  async enqueue(job: JobRequest): Promise<void> {
    const stored = await this.store.createJob(job);
    this.pending++;
    this.chain = this.chain.then(async () => {
      try {
        await this.store.startJob(stored.id);
        this.log(`job ${stored.id} ${stored.kind} started`);
        const outcome = await this.worker.run(stored);
        await this.store.finishJob(stored.id, outcome);
        this.log(`job ${stored.id} ${stored.kind} ${outcome}`);
      } catch (err) {
        this.log(`job ${stored.id} ${stored.kind} failed`, err);
        await this.store.finishJob(stored.id, "failed", String(err)).catch(() => {});
      } finally {
        this.pending--;
      }
    });
  }

  /** Resolves when every job enqueued so far has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  get size(): number {
    return this.pending;
  }
}
