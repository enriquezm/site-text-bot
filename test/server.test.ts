import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import type { JobRequest } from "../src/types.js";

const TOKEN = "test-auth-token";
const PUBLIC_URL = "https://bot.example.com";
const OWNER = "+17025550100";

function setup() {
  const store = new MemoryStore();
  store.senders.set(OWNER, { phone: OWNER, name: "Myles", role: "owner" });
  const jobs: JobRequest[] = [];
  const app = buildServer({
    store,
    queue: { enqueue: async (j) => void jobs.push(j) },
    twilioAuthToken: TOKEN,
    publicUrl: PUBLIC_URL,
    threadTtlMinutes: 60,
  });
  return { app, store, jobs };
}

function signedPost(app: ReturnType<typeof setup>["app"], params: Record<string, string>, sig?: string) {
  const signature = sig ?? twilio.getExpectedTwilioSignature(TOKEN, `${PUBLIC_URL}/sms`, params);
  return app.inject({
    method: "POST",
    url: "/sms",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    payload: new URLSearchParams(params).toString(),
  });
}

describe("POST /sms", () => {
  it("rejects requests without a valid Twilio signature", async () => {
    const { app, jobs } = setup();
    const res = await signedPost(app, { From: OWNER, Body: "update the headline" }, "forged");
    expect(res.statusCode).toBe(403);
    expect(jobs).toHaveLength(0);
  });

  it("ignores numbers not on the allowlist, without a reply", async () => {
    const { app, jobs, store } = setup();
    const res = await signedPost(app, { From: "+15555550000", Body: "update the headline" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(jobs).toHaveLength(0);
    expect(store.threads.size).toBe(0);
  });

  it("replies 'on it' and queues a plan job for the owner", async () => {
    const { app, jobs, store } = setup();
    const res = await signedPost(app, { From: OWNER, Body: "update the headline to say Hi" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Message>On it.</Message>");
    expect(jobs).toEqual([{ kind: "plan", phone: OWNER, gen: 1 }]);
    expect((await store.getThread(OWNER)).state).toBe("planning");
  });

  it("escapes XML in replies", async () => {
    const { app, store } = setup();
    await store.saveThread({
      ...(await store.getThread(OWNER)),
      state: "reviewing",
      previewUrl: "https://x.onrender.com/?a=1&b=<2>",
      prNumber: 1,
    });
    const res = await signedPost(app, { From: OWNER, Body: "hmm" });
    expect(res.body).toContain("a=1&amp;b=&lt;2&gt;");
  });
});
