import pg from "pg";
import {
  emptyThread,
  type AllowedSender,
  type JobKind,
  type JobRequest,
  type ShippedChange,
  type Thread,
} from "./types.js";

export interface StoredJob extends JobRequest {
  id: number;
}

export interface Store {
  getSender(phone: string): Promise<AllowedSender | null>;
  getThread(phone: string): Promise<Thread>;
  saveThread(thread: Thread): Promise<void>;
  lastShipped(): Promise<ShippedChange | null>;
  recordShipped(change: ShippedChange): Promise<void>;
  markReverted(prNumber: number): Promise<void>;
  createJob(job: JobRequest): Promise<StoredJob>;
  finishJob(id: number, status: "done" | "failed" | "discarded", error?: string): Promise<void>;
  startJob(id: number): Promise<void>;
  /** Jobs left queued or running by a previous process; marks them interrupted. */
  takeInterruptedJobs(): Promise<StoredJob[]>;
}

const SCHEMA = `
create table if not exists allowlist (
  phone text primary key,
  name text not null,
  role text not null check (role in ('owner', 'requester')),
  created_at timestamptz not null default now()
);
create table if not exists threads (
  phone text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists jobs (
  id bigserial primary key,
  phone text not null,
  kind text not null,
  gen integer not null,
  payload jsonb,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists shipped (
  pr_number integer primary key,
  title text not null,
  merge_sha text not null,
  phone text not null,
  shipped_at timestamptz not null default now(),
  reverted_at timestamptz
);
`;

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  static async connect(databaseUrl: string): Promise<PgStore> {
    const ssl = /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl });
    await pool.query(SCHEMA);
    return new PgStore(pool);
  }

  async seedOwner(phone: string, name: string): Promise<void> {
    await this.pool.query(
      `insert into allowlist (phone, name, role) values ($1, $2, 'owner') on conflict (phone) do nothing`,
      [phone, name],
    );
  }

  async getSender(phone: string): Promise<AllowedSender | null> {
    const { rows } = await this.pool.query(`select phone, name, role from allowlist where phone = $1`, [phone]);
    return (rows[0] as AllowedSender | undefined) ?? null;
  }

  async getThread(phone: string): Promise<Thread> {
    const { rows } = await this.pool.query(`select data from threads where phone = $1`, [phone]);
    return (rows[0]?.data as Thread | undefined) ?? emptyThread(phone, new Date());
  }

  async saveThread(thread: Thread): Promise<void> {
    await this.pool.query(
      `insert into threads (phone, data, updated_at) values ($1, $2, now())
       on conflict (phone) do update set data = excluded.data, updated_at = now()`,
      [thread.phone, JSON.stringify(thread)],
    );
  }

  async lastShipped(): Promise<ShippedChange | null> {
    const { rows } = await this.pool.query(
      `select pr_number, title, merge_sha, phone from shipped
       where reverted_at is null order by shipped_at desc limit 1`,
    );
    const r = rows[0];
    return r ? { prNumber: r.pr_number, title: r.title, mergeSha: r.merge_sha, phone: r.phone } : null;
  }

  async recordShipped(c: ShippedChange): Promise<void> {
    await this.pool.query(
      `insert into shipped (pr_number, title, merge_sha, phone) values ($1, $2, $3, $4)
       on conflict (pr_number) do nothing`,
      [c.prNumber, c.title, c.mergeSha, c.phone],
    );
  }

  async markReverted(prNumber: number): Promise<void> {
    await this.pool.query(`update shipped set reverted_at = now() where pr_number = $1`, [prNumber]);
  }

  async createJob(job: JobRequest): Promise<StoredJob> {
    const { rows } = await this.pool.query(
      `insert into jobs (phone, kind, gen, payload) values ($1, $2, $3, $4) returning id`,
      [job.phone, job.kind, job.gen, job.payload ? JSON.stringify(job.payload) : null],
    );
    return { ...job, id: Number(rows[0].id) };
  }

  async startJob(id: number): Promise<void> {
    await this.pool.query(`update jobs set status = 'running', updated_at = now() where id = $1`, [id]);
  }

  async finishJob(id: number, status: "done" | "failed" | "discarded", error?: string): Promise<void> {
    await this.pool.query(`update jobs set status = $2, error = $3, updated_at = now() where id = $1`, [
      id,
      status,
      error ?? null,
    ]);
  }

  async takeInterruptedJobs(): Promise<StoredJob[]> {
    const { rows } = await this.pool.query(
      `update jobs set status = 'interrupted', updated_at = now()
       where status in ('queued', 'running') returning id, phone, kind, gen, payload`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      phone: r.phone as string,
      kind: r.kind as JobKind,
      gen: r.gen as number,
      ...(r.payload ? { payload: r.payload as Record<string, unknown> } : {}),
    }));
  }
}

/** In-memory store for tests and local experiments. */
export class MemoryStore implements Store {
  senders = new Map<string, AllowedSender>();
  threads = new Map<string, Thread>();
  shipped: (ShippedChange & { reverted: boolean })[] = [];
  jobs: (StoredJob & { status: string; error?: string })[] = [];

  async getSender(phone: string) {
    return this.senders.get(phone) ?? null;
  }
  async getThread(phone: string) {
    return structuredClone(this.threads.get(phone) ?? emptyThread(phone, new Date()));
  }
  async saveThread(thread: Thread) {
    this.threads.set(thread.phone, structuredClone(thread));
  }
  async lastShipped() {
    const c = [...this.shipped].reverse().find((s) => !s.reverted);
    return c ? { prNumber: c.prNumber, title: c.title, mergeSha: c.mergeSha, phone: c.phone } : null;
  }
  async recordShipped(c: ShippedChange) {
    this.shipped.push({ ...c, reverted: false });
  }
  async markReverted(prNumber: number) {
    for (const s of this.shipped) if (s.prNumber === prNumber) s.reverted = true;
  }
  async createJob(job: JobRequest) {
    const stored = { ...job, id: this.jobs.length + 1, status: "queued" };
    this.jobs.push(stored);
    return stored;
  }
  async startJob(id: number) {
    const j = this.jobs.find((x) => x.id === id);
    if (j) j.status = "running";
  }
  async finishJob(id: number, status: string, error?: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (j) Object.assign(j, { status, error });
  }
  async takeInterruptedJobs() {
    const left = this.jobs.filter((j) => j.status === "queued" || j.status === "running");
    for (const j of left) j.status = "interrupted";
    return left;
  }
}
