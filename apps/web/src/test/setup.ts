import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// Routes and the Composer are now code-split (React.lazy + Suspense), so the
// components under test resolve through a dynamic import. Under the parallel
// test pool (maxWorkers 50%) that import — plus the heavy TipTap mount, made
// heavier by the composer's autosave (#178) — can take longer than a short
// findBy*/waitFor budget before they give up, which shows up as flaky "dialog
// never appeared" timeouts only under load. 5s still raced the lazy composer
// under contention; 10s gives those Suspense boundaries room while staying
// under the 15s per-test timeout that guards a genuinely stuck render.
configure({ asyncUtilTimeout: 10000 });

// jsdom's AbortController/AbortSignal are not recognized by Node's built-in
// fetch (undici), which validates `signal` against its own internal
// AbortSignal brand. react-router's data router builds a `Request` with a
// jsdom-originated signal on every navigation (even without loaders), which
// throws "Expected signal to be an instance of AbortSignal" in this
// environment — and this holds for *any* AbortSignal constructed while a
// jsdom vm-context is active, including a freshly created native
// AbortController's own signal, so the signal can never be threaded through
// the native Request constructor here.
//
// Bridge it instead of silently dropping it: construct the Request without
// `signal` (that path is unaffected), then override the resulting instance's
// `.signal` so any code that reads it still gets a real, working
// AbortSignal that forwards abort state from the original signal.
const NativeRequest = globalThis.Request;
class PatchedRequest extends NativeRequest {
  // biome-ignore lint/correctness/noUnreachableSuper: the two super() calls are on mutually exclusive try/catch paths — exactly one runs per construction (the AbortSignal fallback bridge described above).
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    try {
      super(input, init);
      return;
    } catch (err) {
      const original = init?.signal;
      if (!original) throw err;
      const { signal: _droppedSignal, ...rest } = init ?? {};
      super(input, rest);
      const controller = new AbortController();
      if (original.aborted) {
        controller.abort(original.reason);
      } else {
        original.addEventListener("abort", () => controller.abort(original.reason), { once: true });
      }
      Object.defineProperty(this, "signal", { value: controller.signal, configurable: true });
    }
  }
}
globalThis.Request = PatchedRequest as unknown as typeof Request;

// jsdom implements no layout, so it ships no Element.prototype.scrollIntoView
// at all — the property is simply absent, and calling it throws rather than
// no-opping. MessageList keeps the selected conversation in view with it
// (GH #251) on the non-virtualized path, so give jsdom the no-op it would have
// had if it did layout. Tests that care about the call spy on it themselves.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

afterEach(() => {
  cleanup();
});
