import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getBenderDir } from "./config.js";

interface SlackMessage {
  user: string;
  text: string;
  channel: string;
  ts: string;
}

const MAX_MESSAGES_PER_KEY = 50;

function memoryDir(): string {
  const dir = resolve(getBenderDir(), "slack-memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9-]/g, "_");
  return resolve(memoryDir(), `${safe}.json`);
}

function load(key: string): SlackMessage[] {
  const fp = filePath(key);
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function save(key: string, messages: SlackMessage[]): void {
  writeFileSync(filePath(key), JSON.stringify(messages.slice(-MAX_MESSAGES_PER_KEY), null, 2));
}

/**
 * Record a message (from user or Bender) to memory.
 */
export function recordMessage(
  channel: string,
  user: string,
  text: string,
  ts: string,
): void {
  // Store per-user (DMs) and per-channel
  const userMessages = load(`user:${user}`);
  userMessages.push({ user, text, channel, ts });
  save(`user:${user}`, userMessages);

  const channelMessages = load(`channel:${channel}`);
  channelMessages.push({ user, text, channel, ts });
  save(`channel:${channel}`, channelMessages);
}

/**
 * Get recent conversation context for a user across all channels.
 */
export function getUserContext(user: string, limit = 20): string {
  const messages = load(`user:${user}`).slice(-limit);
  if (messages.length === 0) return "";
  return messages
    .map((m) => `[${m.channel}] ${m.user === user ? "human" : "bender"}: ${m.text}`)
    .join("\n");
}

/**
 * Get recent conversation context for a channel.
 */
export function getChannelContext(channel: string, limit = 20): string {
  const messages = load(`channel:${channel}`).slice(-limit);
  if (messages.length === 0) return "";
  return messages
    .map((m) => `${m.user}: ${m.text}`)
    .join("\n");
}
