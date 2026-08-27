async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The break-glass credential: the bootstrap login's password and the setup
 * API's token, one secret for both.
 *
 * It is SUPPLIED by the operator (`BOOTSTRAP_PASSWORD`), not generated here
 * (GH #235). This server used to mint 18 random bytes at boot, which was the
 * strong half of the design and left it with a problem it could not solve: a
 * secret only the process knows has to be handed to a human somehow, and the
 * channel it used was `log("warn", …)` — the one place in a container that is
 * archived, shipped to an aggregator and readable by everyone with log access,
 * which is a far wider circle than the one holding the secrets. The credential
 * outlived the process it was printed for, in a store nobody thinks of as a
 * secret store.
 *
 * Asking the operator to set it deletes the delivery problem instead of moving
 * it: the credential is born in the secret manager that already holds
 * MASTER_KEY — which is the trust boundary it belongs to anyway, since it grants
 * admin access — travels the same path as every other secret this process
 * takes, and never has to be emitted at all. Rotation is a variable change;
 * revocation is `BOOTSTRAP_MODE=false`, which the runbook already demands.
 * Length is enforced in core/config.ts, which refuses to boot without it.
 */
export function createBootstrap(enabled: boolean, password?: string) {
  // Fails SAFE on a missing credential rather than inventing one: no secret,
  // no break-glass door. Unreachable through a normal boot — core/config.ts
  // rejects `BOOTSTRAP_MODE=true` without a password long before this runs —
  // and the safe answer is the right one for a path that grants admin.
  if (!enabled || !password) {
    return {
      enabled: false as const,
      password: null,
      verify: async () => false,
    };
  }
  const hashPromise = sha256Hex(password);
  return {
    enabled: true as const,
    password,
    verify: async (candidate: string) => (await sha256Hex(candidate)) === (await hashPromise),
  };
}

export type Bootstrap = ReturnType<typeof createBootstrap>;
