import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { getBenderDir } from "./config.js";

export interface WorkerState {
  pid: number;
  logFile: string;
  startedAt: string;
  ticketId: string;
  channel: string;
  threadTs: string;
  description: string;
  claudeSessionId: string | null;
  status: "running" | "done" | "cancelled" | "error";
  exitCode: number | null;
  durationMs: number | null;
}

function workersDir(): string {
  const dir = resolve(getBenderDir(), "workers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function workerKey(channel: string, threadTs: string): string {
  return `${channel}_${threadTs}`.replace(/[/:]/g, "_");
}

function workerPath(channel: string, threadTs: string): string {
  return resolve(workersDir(), `${workerKey(channel, threadTs)}.json`);
}

export function saveWorker(state: WorkerState): void {
  writeFileSync(workerPath(state.channel, state.threadTs), JSON.stringify(state, null, 2));
}

export function getWorker(channel: string, threadTs: string): WorkerState | null {
  const fp = workerPath(channel, threadTs);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

export function clearWorker(channel: string, threadTs: string): void {
  const fp = workerPath(channel, threadTs);
  try { if (existsSync(fp)) unlinkSync(fp); } catch {}
}

export function listRunningWorkers(): WorkerState[] {
  const dir = workersDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const workers: WorkerState[] = [];
  for (const f of files) {
    try {
      const state = JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as WorkerState;
      if (state.status === "running") {
        // Verify the process is actually still running
        try {
          process.kill(state.pid, 0);
          workers.push(state);
        } catch {
          // Process is dead but state says running — mark as error
          state.status = "error";
          state.exitCode = -1;
          writeFileSync(resolve(dir, f), JSON.stringify(state, null, 2));
        }
      }
    } catch {}
  }
  return workers;
}

export function getRunningWorkerForThread(channel: string, threadTs: string): WorkerState | null {
  const state = getWorker(channel, threadTs);
  if (!state || state.status !== "running") return null;
  // Verify process is alive
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    state.status = "error";
    saveWorker(state);
    return null;
  }
}

export function cancelWorker(channel: string, threadTs: string): WorkerState | null {
  const state = getWorker(channel, threadTs);
  if (!state || state.status !== "running") return null;

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}

  state.status = "cancelled";
  state.durationMs = Date.now() - new Date(state.startedAt).getTime();
  saveWorker(state);
  console.log(`[worker-tracker] Cancelled worker pid=${state.pid} in thread ${threadTs}`);
  return state;
}

export function getWorkerLogTail(state: WorkerState, lines = 10): string {
  if (!existsSync(state.logFile)) return "(no log file)";
  try {
    const content = readFileSync(state.logFile, "utf-8");
    const toolLines = content.split("\n").filter((l) => l.startsWith("[tool]"));
    // Show the full tool line (includes command/path info) for the last N calls
    const lastTools = toolLines.slice(-lines)
      .map((l) => `  ${l.slice(0, 200)}`)
      .join("\n");
    return lastTools || "(no tool calls yet — worker is still starting up)";
  } catch {
    return "(error reading log)";
  }
}

export function getWorkerSummary(channel: string, threadTs: string): string {
  const state = getRunningWorkerForThread(channel, threadTs);
  if (!state) return "";

  const elapsed = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const lastTools = getWorkerLogTail(state, 3);

  return `Worker running for ${mins}m${secs}s: "${state.description.slice(0, 80)}"\nRecent activity:\n${lastTools}`;
}

// Clean up stale worker files (older than 24h)
export function cleanupWorkers(): void {
  const dir = workersDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const f of files) {
    try {
      const state = JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as WorkerState;
      if (state.status !== "running" && new Date(state.startedAt).getTime() < cutoff) {
        unlinkSync(resolve(dir, f));
      }
    } catch {}
  }
}
