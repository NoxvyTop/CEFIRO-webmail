import { trustedServicesSchema, type TrustedServices } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";

// GH #314: the reader's calls behind the trusted-service affordances — the
// list (seed + the user's own confirmed domains) and the per-domain add/remove
// that PUT/DELETE /api/mail/trusted-services/:domain expose. Kept beside
// aiApi.ts rather than in mailbox/api.ts: these are reader-only, and that file
// is the mailbox listing's surface.

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

export async function fetchTrustedServices(): Promise<TrustedServices> {
  const res = await fetch("/api/mail/trusted-services");
  if (!res.ok) return parseError(res);
  return trustedServicesSchema.parse(await res.json());
}

// Adds `domain` to the user's trusted-service list. The server normalises and
// validates the domain (400 invalid_domain for anything that is not a plain
// hostname) and is idempotent — trusting an already-trusted domain returns the
// same lists. Encoded so the value can only ever be the path segment.
export async function trustService(domain: string): Promise<TrustedServices> {
  const res = await fetch(`/api/mail/trusted-services/${encodeURIComponent(domain)}`, { method: "PUT" });
  if (!res.ok) return parseError(res);
  return trustedServicesSchema.parse(await res.json());
}

// Removes `domain` from the USER list only. A seed entry is refused with 409
// trusted_service_seed — the caller must not offer this for seed domains (see
// ThreadView, which checks the user list before rendering the action).
export async function untrustService(domain: string): Promise<TrustedServices> {
  const res = await fetch(`/api/mail/trusted-services/${encodeURIComponent(domain)}`, {
    method: "DELETE",
  });
  if (!res.ok) return parseError(res);
  return trustedServicesSchema.parse(await res.json());
}
