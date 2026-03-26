import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Config, Secrets } from "./types.js";

const BENDER_DIR = resolve(homedir(), ".bender");

const DEFAULT_CONFIG: Config = {
  claude: {
    model: "claude-sonnet-4-20250514",
    max_turns: 50,
  },
  workers: {
    max_concurrent: 3,
  },
  circuit_breaker: {
    max_duration_minutes: 30,
    max_tokens: 100000,
  },
  retry: {
    max_retries: 3,
  },
};

export function loadConfig(): Config {
  const configPath = resolve(BENDER_DIR, "config.json");
  if (!existsSync(configPath)) {
    console.warn(`No config.json found at ${configPath}, using defaults`);
    return DEFAULT_CONFIG;
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return { ...DEFAULT_CONFIG, ...raw };
}

export function loadSecrets(): Secrets {
  const envPath = resolve(BENDER_DIR, "secrets.env");
  if (!existsSync(envPath)) {
    throw new Error(`secrets.env not found at ${envPath}`);
  }
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);
    process.env[key] = value;
  }

  const required = [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required secret: ${key}`);
    }
  }

  return {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID!,
    GITHUB_APP_PRIVATE_KEY_PATH: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET!,
    LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID ?? "",
    LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET ?? "",
    LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET ?? "",
    LINEAR_APP_WEBHOOK_SECRET: process.env.LINEAR_APP_WEBHOOK_SECRET ?? "",
    LUNAR_HUB_TOKEN: process.env.LUNAR_HUB_TOKEN ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  };
}

export function getBenderDir(): string {
  return BENDER_DIR;
}
