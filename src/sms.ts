import twilio from "twilio";
import type { Config } from "./config.js";

export interface Sms {
  send(to: string, body: string): Promise<void>;
}

export class TwilioSms implements Sms {
  private client: ReturnType<typeof twilio>;

  constructor(private cfg: Config["twilio"]) {
    this.client = twilio(cfg.accountSid, cfg.authToken);
  }

  async send(to: string, body: string): Promise<void> {
    await this.client.messages.create({ to, from: this.cfg.fromNumber, body: body.slice(0, 1500) });
  }
}

export function verifyTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** TwiML response: an immediate reply, or an empty response for no reply. */
export function twiml(reply: string | null): string {
  const body = reply ? `<Message>${escapeXml(reply.slice(0, 1500))}</Message>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}
