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

// GH #304: the draft is driven by the `intent` the user typed in the body; the
// `subject` is an optional weak hint and `context` is the original message body
// on a reply (GH #299), so the server can ground the draft in what it replies
// to. Undefined optional fields are dropped by JSON.stringify, so a brand-new
// compose sends just `{ intent }`.
export async function fetchAiDraft(input: {
  intent: string;
  subject?: string;
  context?: string;
}): Promise<string> {
  const res = await fetch("/api/mail/compose/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draftInputSchema.parse(input)),
  });
  if (!res.ok) return parseError(res);
  return draftResultSchema.parse(await res.json()).body;
}
