import { draftInputSchema, draftResultSchema } from "@webmail/shared";
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

export async function fetchAiDraft(subject: string): Promise<string> {
  const res = await fetch("/api/mail/compose/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draftInputSchema.parse({ subject })),
  });
  if (!res.ok) return parseError(res);
  return draftResultSchema.parse(await res.json()).body;
}
