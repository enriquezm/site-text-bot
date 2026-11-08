function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export interface Config {
  port: number;
  /** Public base URL of this service, e.g. https://site-text-bot.onrender.com. Used to verify Twilio signatures. */
  publicUrl: string;
  databaseUrl: string;
  twilio: { accountSid: string; authToken: string; fromNumber: string };
  github: { token: string; owner: string; repo: string; baseBranch: string };
  /** Render preview URL pattern; `{pr}` is replaced by the pull request number. Used when GitHub has no deployment URL yet. */
  previewUrlTemplate?: string;
  /** Seed for the allowlist: the owner's phone number in E.164 form, e.g. +17025551234. */
  ownerPhone?: string;
  ownerName: string;
  claudeModel?: string;
  /** Minutes of inactivity before a conversation thread expires. */
  threadTtlMinutes: number;
  /** Skip the Twilio signature check. Local development only. */
  skipSignatureCheck: boolean;
}

export function loadConfig(): Config {
  const skipSignatureCheck = process.env.SKIP_TWILIO_SIGNATURE === "true";
  if (skipSignatureCheck && process.env.NODE_ENV === "production") {
    throw new Error("SKIP_TWILIO_SIGNATURE cannot be used in production");
  }
  required("ANTHROPIC_API_KEY"); // read by Claude Code directly
  return {
    port: Number(process.env.PORT ?? 3000),
    publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
    databaseUrl: required("DATABASE_URL"),
    twilio: {
      accountSid: required("TWILIO_ACCOUNT_SID"),
      authToken: required("TWILIO_AUTH_TOKEN"),
      fromNumber: required("TWILIO_FROM_NUMBER"),
    },
    github: {
      token: required("GITHUB_TOKEN"),
      owner: process.env.GITHUB_OWNER ?? "enriquezm",
      repo: process.env.GITHUB_REPO ?? "new-smyles",
      baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
    },
    previewUrlTemplate: process.env.PREVIEW_URL_TEMPLATE || undefined,
    ownerPhone: process.env.OWNER_PHONE || undefined,
    ownerName: process.env.OWNER_NAME ?? "Myles",
    claudeModel: process.env.CLAUDE_MODEL || undefined,
    threadTtlMinutes: Number(process.env.THREAD_TTL_MINUTES ?? 60),
    skipSignatureCheck,
  };
}
