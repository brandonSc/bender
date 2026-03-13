import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import type { Secrets } from "./types.js";

let appOctokit: Octokit | null = null;
let privateKey: string | null = null;
let appId: string | null = null;

export function initGitHubAuth(secrets: Secrets): void {
  privateKey = readFileSync(secrets.GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
  appId = secrets.GITHUB_APP_ID;
  appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
    },
  });
}

/**
 * Get an authenticated Octokit client for a specific installation.
 * Installation tokens are short-lived (1 hour) and scoped to the installed repos.
 */
export async function getInstallationOctokit(
  installationId: number,
): Promise<Octokit> {
  if (!privateKey || !appId) {
    throw new Error("GitHub auth not initialized — call initGitHubAuth first");
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });
}

/**
 * Get a GitHub token for CLI tools (gh, git) for a specific installation.
 */
export async function getInstallationToken(
  installationId: number,
): Promise<string> {
  if (!privateKey || !appId) {
    throw new Error("GitHub auth not initialized — call initGitHubAuth first");
  }

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  });

  const { token } = await auth({ type: "installation" });
  return token;
}

export function getAppOctokit(): Octokit {
  if (!appOctokit) {
    throw new Error("GitHub auth not initialized — call initGitHubAuth first");
  }
  return appOctokit;
}
