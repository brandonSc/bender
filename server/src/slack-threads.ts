// Track threads where Bender was mentioned — reply to follow-ups without needing @mention

const activeThreads = new Map<string, number>();
const THREAD_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Mark a thread as active (Bender was mentioned in it).
 */
export function trackThread(channelAndTs: string): void {
  activeThreads.set(channelAndTs, Date.now());
  cleanup();
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
    return false;
  }
  // Refresh the timeout
  activeThreads.set(key, Date.now());
  return true;
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, ts] of activeThreads) {
    if (now - ts > THREAD_TIMEOUT_MS) activeThreads.delete(key);
  }
}
