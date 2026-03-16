import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getBenderDir } from "./config.js";

const TOKEN_FILE = "linear-token.json";

interface LinearToken {
  access_token: string;
  token_type: string;
  scope: string;
  created_at: string;
}

/**
 * Get the stored Linear OAuth access token, or null if not yet authorized.
 */
export function getLinearToken(): string | null {
  const tokenPath = resolve(getBenderDir(), TOKEN_FILE);
  if (!existsSync(tokenPath)) return null;
  const data: LinearToken = JSON.parse(readFileSync(tokenPath, "utf-8"));
  return data.access_token;
}

/**
 * Build the Linear OAuth authorization URL.
 */
export function getAuthorizationUrl(
  clientId: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read,write,issues:create,comments:create",
    prompt: "consent",
  });
  return `https://linear.app/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for an access token.
 */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Linear token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const token: LinearToken = {
    access_token: data.access_token,
    token_type: data.token_type ?? "Bearer",
    scope: data.scope ?? "",
    created_at: new Date().toISOString(),
  };

  // Persist the token
  const tokenPath = resolve(getBenderDir(), TOKEN_FILE);
  writeFileSync(tokenPath, JSON.stringify(token, null, 2));
  console.log(`[linear] OAuth token saved to ${tokenPath}`);

  return token.access_token;
}
