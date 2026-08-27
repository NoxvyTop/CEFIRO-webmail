import i18n from "../../app/i18n";

// The setup wizard lives entirely behind the bootstrap latch and shares no
// codes with the app-wide error walk, so `setup` is not part of the shared
// ErrorNamespace union in app/errorMessages.ts. It resolves its own codes here,
// but by the same rule that function uses (GH #215): a code with its own
// `setup.errors.<code>` message keeps it, and anything unmapped — a new server
// code, a client-side `network_error`, an empty code — falls back to
// `setup.errors.generic` rather than surfacing a raw key to the operator.
export function setupErrorKey(code: string | null | undefined): string {
  const generic = "setup.errors.generic";
  if (!code) return generic;
  const key = `setup.errors.${code}`;
  return i18n.exists(key) ? key : generic;
}
