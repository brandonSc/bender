const SLACK_API = "https://slack.com/api";

function getToken(): string {
  return process.env.SLACK_BOT_TOKEN ?? "";
}

async function slackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = getToken();
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.ok) {
    console.error(`[slack] ${method} failed:`, data.error);
  }
  return data;
}

async function slackGet(
  method: string,
  params: Record<string, string | number>,
): Promise<Record<string, unknown>> {
  const token = getToken();
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();

  const resp = await fetch(`${SLACK_API}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.ok) {
    console.error(`[slack] ${method} failed:`, data.error);
  }
  return data;
}

export async function postMessage(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string | undefined> {
  console.log(
    `[slack:out] → ${channel}${threadTs ? ` (thread ${threadTs})` : ""}: "${text.slice(0, 200)}"${text.length > 200 ? "…" : ""}`,
  );
  const result = await slackApi("chat.postMessage", {
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return (result.message as Record<string, unknown>)?.ts as string | undefined;
}

export async function addReaction(
  channel: string,
  timestamp: string,
  emoji: string,
): Promise<void> {
  console.log(`[slack:out] → ${channel} react :${emoji}: on ${timestamp}`);
  await slackApi("reactions.add", {
    channel,
    timestamp,
    name: emoji,
  });
}

export async function getThreadMessages(
  channel: string,
  threadTs: string,
  limit = 50,
): Promise<Array<{ user: string; text: string; ts: string }>> {
  const data = await slackGet("conversations.replies", {
    channel,
    ts: threadTs,
    limit,
  });
  return (data.messages as Array<{ user: string; text: string; ts: string }>) ?? [];
}

export async function getChannelHistory(
  channel: string,
  limit = 10,
): Promise<Array<{ user: string; text: string; ts: string }>> {
  const data = await slackGet("conversations.history", {
    channel,
    limit,
  });
  return (data.messages as Array<{ user: string; text: string; ts: string }>) ?? [];
}

export interface MessageReaction {
  name: string;
  count: number;
  users: string[];
}

export async function getReactions(
  channel: string,
  timestamp: string,
): Promise<MessageReaction[]> {
  const data = await slackGet("reactions.get", { channel, timestamp });
  const message = data.message as Record<string, unknown> | undefined;
  const reactions = message?.reactions as MessageReaction[] | undefined;
  return reactions ?? [];
}
