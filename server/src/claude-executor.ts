import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { getBenderDir } from "./config.js";
import { getLinearToken } from "./linear-auth.js";
import type { Config, Session } from "./types.js";

export interface ClaudeResult {
  exitCode: number;
  sessionId: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
}

/**
 * Invoke Claude Code CLI for a task.
 *
 * - New sessions: `claude --model <model> --dangerously-skip-permissions -p <prompt>`
 * - Resumed sessions: `claude --resume <id> --dangerously-skip-permissions -p <message>`
 */
export async function invokeClaude(
  session: Session,
  prompt: string,
  config: Config,
  githubToken?: string,
  lightMode?: boolean,
): Promise<ClaudeResult> {
  const args: string[] = [];
  const isResume = !!session.claude_session_id;

  const model = lightMode ? "claude-sonnet-4-20250514" : config.claude.model;
  args.push("--model", model);
  if (isResume) {
    args.push("--resume", session.claude_session_id!);
  }

  args.push("--dangerously-skip-permissions");
  if (!lightMode) {
    args.push("--effort", "max");
  }
  args.push("--output-format", "stream-json");
  args.push("--verbose");
  if (config.claude.max_turns > 0) {
    args.push("--max-turns", config.claude.max_turns.toString());
  }
  args.push("-p", prompt);

  const reposDir = resolve(homedir(), "repos");
  mkdirSync(reposDir, { recursive: true });

  // Pick the best CWD: worktree > cloned repo > ~/repos
  const lunarLibDir = resolve(reposDir, "lunar-lib");
  let cwd: string;
  if (existsSync(session.worktree_path)) {
    cwd = session.worktree_path;
  } else if (existsSync(lunarLibDir)) {
    cwd = lunarLibDir;
  } else {
    cwd = reposDir;
  }
  const startTime = Date.now();

  // Set up logging
  const logsDir = resolve(getBenderDir(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const invocationCount =
    session.checkpoint_count * 100 +
    parseInt(session.last_event_id.split(":").pop() ?? "0", 10);
  const logFile = resolve(
    logsDir,
    `${new Date().toISOString().split("T")[0]}-${session.ticket_id}-${String(invocationCount).padStart(3, "0")}.log`,
  );

  appendFileSync(logFile, `=== Claude Invocation (${isResume ? "RESUME " + session.claude_session_id : "NEW"}) ===\n`);
  appendFileSync(logFile, `Time: ${new Date().toISOString()}\n`);
  appendFileSync(logFile, `Ticket: ${session.ticket_id}\n`);
  appendFileSync(logFile, `Session: ${session.claude_session_id ?? "new"}\n`);
  appendFileSync(logFile, `CWD: ${cwd}\n`);
  appendFileSync(logFile, `Model: ${config.claude.model}\n`);
  appendFileSync(logFile, `Args: ${args.join(" ")}\n`);
  appendFileSync(logFile, `\n--- Prompt ---\n${prompt}\n\n`);

  return new Promise<ClaudeResult>((resolvePromise) => {
    const child = spawn("claude", args, {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ...(githubToken ? { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken } : {}),
        ...(session.agent_session_id ? {
          BENDER_AGENT_SESSION_ID: session.agent_session_id,
          BENDER_LINEAR_TOKEN: getLinearToken() ?? "",
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let rawOutput = "";
    let textOutput = "";
    let sessionId = session.claude_session_id;
    let stderr = "";
    let killed = false;

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
      appendFileSync(logFile, `\n--- Spawn Error ---\n${err.message}\n`);
      resolvePromise({
        exitCode: 1,
        sessionId: session.claude_session_id,
        stdout: "",
        stderr: err.message,
        durationMs,
        killed: false,
      });
    });

    // Parse stream-json: each line is a JSON event
    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      rawOutput += chunk;

      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          // Extract text content
          if (evt.type === "text" || evt.event?.delta?.text) {
            const text = evt.text ?? evt.event?.delta?.text ?? "";
            textOutput += text;
          }
          // Extract session ID from result event
          if (evt.session_id) sessionId = evt.session_id;
          if (evt.type === "result" && evt.session_id) sessionId = evt.session_id;
          // Log tool use for visibility
          if (evt.type === "tool_use") {
            appendFileSync(logFile, `[tool] ${evt.tool ?? evt.name}: ${JSON.stringify(evt.input ?? "").slice(0, 100)}\n`);
          }
        } catch {
          // Not JSON — raw text
          textOutput += line;
        }
      }
      appendFileSync(logFile, chunk);
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      appendFileSync(logFile, chunk);
    });

    // Circuit breaker: kill if exceeding time limit
    const timeout = setTimeout(
      () => {
        killed = true;
        child.kill("SIGTERM");
        appendFileSync(
          logFile,
          `\n=== KILLED: exceeded ${config.circuit_breaker.max_duration_minutes}min limit ===\n`,
        );
      },
      config.circuit_breaker.max_duration_minutes * 60 * 1000,
    );

    child.on("close", (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;

      appendFileSync(logFile, `\n--- Result ---\n`);
      appendFileSync(logFile, `Exit code: ${code}\n`);
      appendFileSync(logFile, `Duration: ${durationMs}ms\n`);
      appendFileSync(logFile, `Killed: ${killed}\n`);

      // Session ID was captured from stream events above
      // Also try stderr as fallback
      if (!sessionId) {
        const match = stderr.match(/session[:\s]+([a-f0-9-]{36})/i);
        if (match) sessionId = match[1];
      }

      appendFileSync(logFile, `Session ID: ${sessionId ?? "none"}\n`);
      appendFileSync(logFile, `Text output length: ${textOutput.length}\n`);

      resolvePromise({
        exitCode: code ?? 1,
        sessionId,
        stdout: textOutput || rawOutput,
        stderr,
        durationMs,
        killed,
      });
    });
  });
}
