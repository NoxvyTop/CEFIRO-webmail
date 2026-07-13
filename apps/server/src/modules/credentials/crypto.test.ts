import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, importMasterKey } from "./crypto";

function randomKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

describe("credential crypto", () => {
  it("round-trips a secret", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "mailbox-password");
    expect(await decryptSecret(key, ciphertext, iv)).toBe("mailbox-password");
  });

  it("produces different ciphertexts for the same plaintext", async () => {
    const key = await importMasterKey(randomKeyB64());
    const a = await encryptSecret(key, "same");
    const b = await encryptSecret(key, "same");
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("fails on tampered ciphertext", async () => {
    const key = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(key, "secret");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    await expect(decryptSecret(key, ciphertext, iv)).rejects.toThrow();
  });

  it("fails with the wrong key", async () => {
    const keyA = await importMasterKey(randomKeyB64());
    const keyB = await importMasterKey(randomKeyB64());
    const { ciphertext, iv } = await encryptSecret(keyA, "secret");
    await expect(decryptSecret(keyB, ciphertext, iv)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importMasterKey(btoa("short"))).rejects.toThrow();
  });
});
