import { ClaudeCodeAgent } from "./claude.js";
import { loadConfig } from "./config.js";
import { GitHub } from "./github.js";
import { JobQueue } from "./queue.js";
import { buildServer } from "./server.js";
import { TwilioSms } from "./sms.js";
import { PgStore } from "./store.js";
import { emptyThread } from "./types.js";
import { Worker } from "./worker.js";
import { installDeps, runChecks, Workspace } from "./workspace.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = await PgStore.connect(cfg.databaseUrl);
  if (cfg.ownerPhone) await store.seedOwner(cfg.ownerPhone, cfg.ownerName);

  const sms = new TwilioSms(cfg.twilio);
  const github = new GitHub(cfg.github, cfg.previewUrlTemplate);
  const worker = new Worker({
    store,
    sms,
    github,
    agent: new ClaudeCodeAgent(cfg.claudeModel),
    openWorkspace: (opts) => Workspace.clone(cfg.github, opts),
    installDeps,
    runChecks,
  });
  const queue = new JobQueue(store, worker);

  // Anything left running by the last process is gone; reset those threads and say so.
  const interrupted = await store.takeInterruptedJobs();
  const phones = new Set(interrupted.filter((j) => j.kind !== "close_pr").map((j) => j.phone));
  for (const phone of phones) {
    const t = await store.getThread(phone);
    if (t.prNumber && t.state !== "reviewing") {
      await github.closePr(t.prNumber, t.branch).catch(() => {});
    }
    if (t.state !== "reviewing") {
      await store.saveThread({ ...emptyThread(phone, new Date()), gen: t.gen + 1 });
      await sms.send(phone, "I restarted in the middle of your request, so I dropped it. Text it again when you're ready.");
    }
  }

  const app = buildServer({
    store,
    queue,
    twilioAuthToken: cfg.twilio.authToken,
    publicUrl: cfg.publicUrl,
    threadTtlMinutes: cfg.threadTtlMinutes,
    skipSignatureCheck: cfg.skipSignatureCheck,
    logger: true,
  });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
