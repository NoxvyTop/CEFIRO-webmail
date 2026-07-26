import {
  blobUploadResultSchema, identitySchema, saveDraftResultSchema, saveDraftSchema, sendEmailSchema,
  signatureSchema, signatureInputSchema,
  type BlobUploadResult, type Identity, type SaveDraftInput, type SaveDraftResult, type SendEmailInput,
  type Signature, type SignatureInput,
} from "@webmail/shared";
import { z } from "zod";
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

function parseXhrError(status: number, responseText: string): MailApiError {
  let code = "internal";
  try {
    code = (JSON.parse(responseText) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  return new MailApiError(status, code);
}

export async function fetchIdentities(): Promise<Identity[]> {
  const res = await fetch("/api/mail/identities");
  if (!res.ok) return parseError(res);
  return z.array(identitySchema).parse(await res.json());
}

export async function fetchSignatures(): Promise<Signature[]> {
  const res = await fetch("/api/mail/signatures");
  if (!res.ok) return parseError(res);
  return z.array(signatureSchema).parse(await res.json());
}

export async function createSignature(input: SignatureInput): Promise<Signature> {
  const res = await fetch("/api/mail/signatures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signatureInputSchema.parse(input)),
  });
  if (!res.ok) return parseError(res);
  return signatureSchema.parse(await res.json());
}

export async function updateSignature(id: string, input: SignatureInput): Promise<Signature> {
  const res = await fetch(`/api/mail/signatures/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signatureInputSchema.parse(input)),
  });
  if (!res.ok) return parseError(res);
  return signatureSchema.parse(await res.json());
}

export async function deleteSignature(id: string): Promise<void> {
  const res = await fetch(`/api/mail/signatures/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return parseError(res);
}

export async function uploadAttachment(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<BlobUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/mail/blobs");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.total > 0) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(blobUploadResultSchema.parse(JSON.parse(xhr.responseText)));
        } catch (err) {
          reject(err);
        }
        return;
      }
      reject(parseXhrError(xhr.status, xhr.responseText));
    };

    xhr.onerror = () => reject(new MailApiError(0, "network_error"));

    xhr.send(file);
  });
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const res = await fetch("/api/mail/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sendEmailSchema.parse(input)),
  });
  if (!res.ok) return parseError(res);
}

// GH #149: unlike sendEmail, returns the created draft's id — a save-draft
// call is only useful to a caller that can act on what it created (e.g. set
// it as originalDraftId on the next save), whereas /send is fire-and-forget
// once it succeeds.
export async function saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
  const res = await fetch("/api/mail/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(saveDraftSchema.parse(input)),
  });
  if (!res.ok) return parseError(res);
  return saveDraftResultSchema.parse(await res.json());
}
