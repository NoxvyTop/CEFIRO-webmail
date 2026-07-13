import { describe, expect, it } from "vitest";
import { importMasterKey } from "../credentials/crypto";
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
});
