import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { handleMessage } from "./conversation.js";
import type { JobQueue } from "./queue.js";
import { twiml, verifyTwilioSignature } from "./sms.js";
import type { Store } from "./store.js";

export interface ServerDeps {
  store: Store;
  queue: Pick<JobQueue, "enqueue">;
  twilioAuthToken: string;
  publicUrl: string;
  threadTtlMinutes: number;
  skipSignatureCheck?: boolean;
  now?: () => Date;
  logger?: boolean;
}

/** Messages from one phone are handled one at a time, in order. */
class PerKeyLock {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });
  app.register(formbody);
  const lock = new PerKeyLock();

  app.get("/health", async () => ({ ok: true }));

  app.post("/sms", async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    const signature = req.headers["x-twilio-signature"] as string | undefined;

    if (!deps.skipSignatureCheck) {
      const url = `${deps.publicUrl}${req.url}`;
      if (!verifyTwilioSignature(deps.twilioAuthToken, signature, url, params)) {
        req.log.warn("rejected webhook with a bad Twilio signature");
        return reply.code(403).send("invalid signature");
      }
    }

    const from = params.From ?? "";
    const text = (params.Body ?? "").trim();
    reply.type("text/xml");

    const sender = await deps.store.getSender(from);
    if (!sender) {
      req.log.info({ from: from.slice(-4) }, "ignored message from a number not on the allowlist");
      return twiml(null);
    }
    if (!text) return twiml(null);

    const answer = await lock.run(from, async () => {
      const outcome = handleMessage({
        sender,
        thread: await deps.store.getThread(from),
        text,
        lastShipped: await deps.store.lastShipped(),
        now: deps.now?.() ?? new Date(),
        ttlMinutes: deps.threadTtlMinutes,
      });
      const history = outcome.reply
        ? [...outcome.thread.history, { from: "bot" as const, text: outcome.reply }]
        : outcome.thread.history;
      await deps.store.saveThread({ ...outcome.thread, history });
      for (const job of outcome.jobs) await deps.queue.enqueue(job);
      return outcome.reply;
    });

    return twiml(answer);
  });

  return app;
}
