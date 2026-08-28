import { describe, expect, it } from "vitest";
import { aadFor, decryptSecret, importMasterKey } from "../credentials/crypto";
import { openState, sealState } from "./oidc-state";

const keyPromise = importMasterKey(
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
);

describe("oidc state cookie", () => {
  it("round-trips", async () => {
    const key = await keyPromise;
    const sealed = await sealState(key, { state: "s1", verifier: "v1", issuedAt: Date.now() });
    const opened = await openState(key, sealed);
    expect(opened?.state).toBe("s1");
    expect(opened?.verifier).toBe("v1");
  });

  it("returns null on tamper", async () => {
    const key = await keyPromise;
    const sealed = await sealState(key, { state: "s", verifier: "v", issuedAt: Date.now() });
    expect(await openState(key, `${sealed}x`)).toBeNull();
  });

  it("returns null when older than maxAge", async () => {
    const key = await keyPromise;
    const sealed = await sealState(key, {
      state: "s", verifier: "v", issuedAt: Date.now() - 700_000,
    });
    expect(await openState(key, sealed)).toBeNull();
  });

  // GH #347: bound to additionalData = "oidc_state" (crypto.ts aadFor), so
  // this cookie cannot be replayed as a decryption of a differently-purposed
  // ciphertext — a mail credential or an SSO client secret — even under the
  // same master key.
  it("binds the sealed cookie to the \"oidc_state\" purpose", async () => {
    const key = await keyPromise;
    const sealed = await sealState(key, { state: "s", verifier: "v", issuedAt: Date.now() });
    const [ivPart, cipherPart] = sealed.split(".");
    const fromB64Url = (value: string) => {
      const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    };
    const iv = fromB64Url(ivPart ?? "");
    const ciphertext = fromB64Url(cipherPart ?? "");

    expect(JSON.parse(await decryptSecret(key, ciphertext, iv, aadFor("oidc_state"))).state).toBe(
      "s",
    );
    await expect(decryptSecret(key, ciphertext, iv, aadFor("sso"))).rejects.toThrow();
  });
});
