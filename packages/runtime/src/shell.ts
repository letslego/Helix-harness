import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runShellCommand(
  command: string,
  opts: {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ShellResult> {
  if (!existsSync(opts.cwd)) {
    mkdirSync(opts.cwd, { recursive: true });
  }
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 200_000) stdout = `${stdout.slice(0, 200_000)}\n...[truncated]`;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = `${stderr.slice(0, 200_000)}\n...[truncated]`;
    });
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    });
  });
}
