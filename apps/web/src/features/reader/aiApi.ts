import { summaryResultSchema } from "@webmail/shared";
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

export async function fetchSummary(messageId: string): Promise<string[]> {
  const res = await fetch(`/api/mail/messages/${encodeURIComponent(messageId)}/summarize`, {
    method: "POST",
  });
  if (!res.ok) return parseError(res);
  return summaryResultSchema.parse(await res.json()).bullets;
}
