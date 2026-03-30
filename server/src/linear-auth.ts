import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getBenderDir } from "./config.js";

const TOKEN_FILE = "linear-token.json";

interface LinearToken {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope: string;
  expires_at?: string;
  created_at: string;
}

let cachedToken: LinearToken | null = null;

function loadToken(): LinearToken | null {
  if (cachedToken) return cachedToken;
  const tokenPath = resolve(getBenderDir(), TOKEN_FILE);
  if (!existsSync(tokenPath)) return null;
  cachedToken = JSON.parse(readFileSync(tokenPath, "utf-8"));
  return cachedToken;
}

function saveToken(token: LinearToken): void {
  cachedToken = token;
  const tokenPath = resolve(getBenderDir(), TOKEN_FILE);
  writeFileSync(tokenPath, JSON.stringify(token, null, 2));
}

/**
 * Get the stored Linear OAuth access token, or null if not yet authorized.
 * Automatically refreshes if expired and refresh_token is available.
 */
export function getLinearToken(): string | null {
  const token = loadToken();
  if (!token) return null;
  return token.access_token;
}

/**
 * Attempt to refresh the token. Called when a 401 is encountered.
 * Returns the new access token, or null if refresh failed.
 */
export async function refreshLinearToken(
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const token = loadToken();
  if (!token?.refresh_token) {
    console.warn("[linear] No refresh token available — re-authorize at /auth/linear");
    return null;
  }

  try {
    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      console.error(`[linear] Token refresh failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const newToken: LinearToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? token.refresh_token,
      token_type: data.token_type ?? "Bearer",
      scope: data.scope ?? token.scope,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      created_at: new Date().toISOString(),
    };

    saveToken(newToken);
    console.log("[linear] Token refreshed successfully");
    return newToken.access_token;
  } catch (err) {
    console.error("[linear] Token refresh error:", err);
    return null;
  }
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
    scope: "read,write,issues:create,comments:create,app:assignable,app:mentionable",
    actor: "app",
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
    refresh_token: data.refresh_token,
    token_type: data.token_type ?? "Bearer",
    scope: data.scope ?? "",
    expires_at: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
    created_at: new Date().toISOString(),
  };

  saveToken(token);
  console.log(`[linear] OAuth token saved (refresh_token: ${token.refresh_token ? "yes" : "no"})`);

  return token.access_token;
}
