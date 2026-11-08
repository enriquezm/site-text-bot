import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number;
  output: string;
}

/** Run a command without a shell; never throws on a non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "true", ...opts.env },
        timeout: opts.timeoutMs ?? 10 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ ok: !err, code, output });
      },
    );
  });
}

export async function mustRun(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (!r.ok) throw new Error(`${cmd} ${redact(args.join(" "))} failed (${r.code}):\n${redact(tail(r.output, 2000))}`);
  return r.output;
}

export function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
}

/** Strip tokens embedded in git URLs from anything that might be logged or texted. */
export function redact(text: string): string {
  return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}
