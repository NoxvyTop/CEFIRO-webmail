// GH #13/#50: the one place the reader builds `/api/mail/blobs/...` URLs, so
// the accountId that scopes a shared-mailbox attachment to its account is
// threaded uniformly — the attachment card, the in-app viewer, the PDF
// thumbnail and the inline-image fetch all go through here instead of each
// re-deriving the query string.
//
// Query order is fixed (name, type, then dl, then accountId) so a personal
// request — no accountId, the default — is byte-for-byte the URL these call
// sites built inline before this helper existed. `name` is nullable because the
// inline-image fetch has no filename to send.
export function blobUrl(
  blobId: string,
  name: string | null,
  type: string,
  options: { download?: boolean; accountId?: string } = {},
): string {
  const query = `name=${encodeURIComponent(name ?? "")}&type=${encodeURIComponent(type)}`;
  const dl = options.download ? "&dl=1" : "";
  const account = options.accountId ? `&accountId=${encodeURIComponent(options.accountId)}` : "";
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}${dl}${account}`;
}
