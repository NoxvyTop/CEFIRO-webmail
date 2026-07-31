import { afterEach, describe, expect, it, vi } from "vitest";
import { clearIdleTimeout, registerServer, resetServerForTests } from "./idle-timeout";

afterEach(() => resetServerForTests());

describe("clearIdleTimeout", () => {
  it("clears the idle deadline (timeout 0) for the given request on the registered server", () => {
    const timeout = vi.fn();
    registerServer({ timeout });
    const request = new Request("http://localhost/api/mail/events");

    clearIdleTimeout(request);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(request, 0);
  });

  it("is a no-op when no server is registered (e.g. under vitest, no Bun.serve)", () => {
    // No registerServer() call: handlers run in tests without a Bun server, so
    // this must not throw.
    expect(() => clearIdleTimeout(new Request("http://localhost/api/mail/events"))).not.toThrow();
  });
});
