// Track threads where Bender was mentioned — reply to follow-ups without needing @mention
// Persisted to disk so threads survive server restarts.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const PERSIST_PATH = resolve(homedir(), ".bender", "tracked-threads.json");
const THREAD_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory map: key "channel:thread_ts" → timestamp (ms)
const activeThreads = new Map<string, number>();

// Load persisted threads on startup
function loadFromDisk(): void {
  try {
    if (existsSync(PERSIST_PATH)) {
      const data: Record<string, number> = JSON.parse(readFileSync(PERSIST_PATH, "utf-8"));
      const now = Date.now();
      for (const [key, ts] of Object.entries(data)) {
        if (now - ts < THREAD_TIMEOUT_MS) {
          activeThreads.set(key, ts);
        }
      }
      console.log(`[threads] Loaded ${activeThreads.size} tracked threads from disk`);
    }
  } catch (e) {
    console.error(`[threads] Failed to load tracked threads:`, e);
  }
}

// Persist to disk (debounced — coalesce rapid writes)
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveToDisk(): void {
  if (saveTimer) return; // already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj: Record<string, number> = {};
      for (const [key, ts] of activeThreads) {
        obj[key] = ts;
      }
      writeFileSync(PERSIST_PATH, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error(`[threads] Failed to persist tracked threads:`, e);
    }
  }, 500);
}

/**
 * Mark a thread as active (Bender was mentioned in it).
 */
export function trackThread(channelAndTs: string): void {
  activeThreads.set(channelAndTs, Date.now());
  cleanup();
  saveToDisk();
}

/**
 * Check if Bender should respond to a message in this thread.
 */
export function isActiveThread(channel: string, threadTs: string | undefined): boolean {
  if (!threadTs) return false;
  const key = `${channel}:${threadTs}`;
  const tracked = activeThreads.get(key);
  if (!tracked) return false;
  if (Date.now() - tracked > THREAD_TIMEOUT_MS) {
    activeThreads.delete(key);
    saveToDisk();
    return false;
  }
  // Refresh the timeout
  activeThreads.set(key, Date.now());
  saveToDisk();
  return true;
}

/**
 * Stop tracking a thread (Bender was dismissed).
 */
export function untrackThread(channel: string, threadTs: string): void {
  const key = `${channel}:${threadTs}`;
  activeThreads.delete(key);
  saveToDisk();
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, ts] of activeThreads) {
    if (now - ts > THREAD_TIMEOUT_MS) activeThreads.delete(key);
  }
}

// Boot: hydrate from disk
loadFromDisk();
