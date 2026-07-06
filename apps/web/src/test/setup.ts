import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom's AbortController/AbortSignal are not recognized by Node's built-in
// fetch (undici), which checks `signal instanceof <its own AbortSignal>`.
// react-router's data router builds a `Request` with a jsdom-originated
// signal on every navigation (even without loaders), which throws
// "Expected signal to be an instance of AbortSignal" in this environment.
// Drop the signal so client-side navigation in tests doesn't crash; it
// carries no test-relevant behavior here (no loaders use it).
const NativeRequest = globalThis.Request;
class PatchedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init && "signal" in init) {
      const { signal: _signal, ...rest } = init;
      super(input, rest);
      return;
    }
    super(input, init);
  }
}
globalThis.Request = PatchedRequest as unknown as typeof Request;

afterEach(() => {
  cleanup();
});
