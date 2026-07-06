function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createBootstrap(enabled: boolean) {
  if (!enabled) {
    return {
      enabled: false as const,
      password: null,
      verify: async () => false,
    };
  }
  const password = toB64Url(crypto.getRandomValues(new Uint8Array(18)));
  const hashPromise = sha256Hex(password);
  return {
    enabled: true as const,
    password,
    verify: async (candidate: string) => (await sha256Hex(candidate)) === (await hashPromise),
  };
}

export type Bootstrap = ReturnType<typeof createBootstrap>;
