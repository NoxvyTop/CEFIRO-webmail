import { aiStatusSchema, draftInputSchema, draftResultSchema } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

// GH #292: whether AI is enabled on the server. Any non-ok response (a 401
// before the session is up, a 5xx, an offline fetch) resolves to `false` so the
// AI CTA stays hidden — the safe default that matches AI being off by default.
export async function fetchAiStatus(): Promise<boolean> {
  try {
    const res = await fetch("/api/mail/ai/status");
    if (!res.ok) return false;
    return aiStatusSchema.parse(await res.json()).enabled;
  } catch {
    return false;
  }
}

export async function fetchAiDraft(subject: string): Promise<string> {
  const res = await fetch("/api/mail/compose/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draftInputSchema.parse({ subject })),
  });
  if (!res.ok) return parseError(res);
  return draftResultSchema.parse(await res.json()).body;
}
