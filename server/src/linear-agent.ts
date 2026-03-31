import { getLinearToken } from "./linear-auth.js";

const LINEAR_API = "https://api.linear.app/graphql";

type ActivityType = "thought" | "action" | "response" | "error" | "elicitation";

interface ActivityContent {
  type: ActivityType;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

async function gql(
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const token = getLinearToken();
  if (!token) throw new Error("Linear not authorized");

  const response = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Linear API error: ${response.status} ${text}`);
  }

  const result = (await response.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };
  if (result.errors?.length) {
    throw new Error(`Linear GraphQL error: ${result.errors[0].message}`);
  }

  return result.data;
}

export async function emitActivity(
  agentSessionId: string,
  content: ActivityContent,
): Promise<void> {
  const preview = content.body?.slice(0, 200) ?? content.action ?? "";
  console.log(
    `[linear:out] → session=${agentSessionId.slice(0, 8)}… type=${content.type}: "${preview}"${(content.body?.length ?? 0) > 200 ? "…" : ""}`,
  );
  try {
    await gql(
      `mutation($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`,
      {
        input: {
          agentSessionId,
          content,
        },
      },
    );
  } catch (err) {
    console.error(`[linear-agent] Failed to emit ${content.type}:`, err);
  }
}

export async function emitThought(
  agentSessionId: string,
  body: string,
): Promise<void> {
  await emitActivity(agentSessionId, { type: "thought", body });
}

export async function emitAction(
  agentSessionId: string,
  action: string,
  parameter: string,
  result?: string,
): Promise<void> {
  await emitActivity(agentSessionId, { type: "action", action, parameter, result });
}

export async function emitResponse(
  agentSessionId: string,
  body: string,
): Promise<void> {
  await emitActivity(agentSessionId, { type: "response", body });
}

export async function emitError(
  agentSessionId: string,
  body: string,
): Promise<void> {
  await emitActivity(agentSessionId, { type: "error", body });
}

export async function emitElicitation(
  agentSessionId: string,
  body: string,
): Promise<void> {
  await emitActivity(agentSessionId, { type: "elicitation", body });
}

export async function updateSessionPlan(
  agentSessionId: string,
  plan: Array<{ content: string; status: "pending" | "inProgress" | "completed" | "canceled" }>,
): Promise<void> {
  try {
    await gql(
      `mutation($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) { success }
      }`,
      {
        id: agentSessionId,
        input: { plan },
      },
    );
  } catch (err) {
    console.error("[linear-agent] Failed to update plan:", err);
  }
}

export async function updateSessionExternalUrl(
  agentSessionId: string,
  label: string,
  url: string,
): Promise<void> {
  try {
    await gql(
      `mutation($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) { success }
      }`,
      {
        id: agentSessionId,
        input: {
          addedExternalUrls: [{ label, url }],
        },
      },
    );
  } catch (err) {
    console.error("[linear-agent] Failed to update external URL:", err);
  }
}
