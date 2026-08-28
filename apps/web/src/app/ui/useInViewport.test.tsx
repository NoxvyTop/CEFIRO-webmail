import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInViewport } from "./useInViewport";

// Minimal IntersectionObserver stand-in — records every instance so a test
// can trigger its callback directly, the same double-per-test-file pattern
// use-mail-events-hook.test.tsx's FakeEventSource uses for EventSource.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve(target: Element) {
    this.observed = this.observed.filter((el) => el !== target);
  }

  disconnect() {
    this.disconnected = true;
  }

  intersect(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function Probe() {
  const [ref, inViewport] = useInViewport<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="probe">
      {inViewport ? "visible" : "hidden"}
    </div>
  );
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useInViewport", () => {
  it("starts out not in the viewport", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("hidden");
  });

  it("flips to in-viewport once the observed element intersects", () => {
    render(<Probe />);
    const observer = FakeIntersectionObserver.instances[0]!;
    const element = screen.getByTestId("probe");
    expect(observer.observed).toContain(element);

    act(() => observer.intersect(element, true));

    expect(screen.getByTestId("probe")).toHaveTextContent("visible");
  });

  it("ignores a non-intersecting entry", () => {
    render(<Probe />);
    const observer = FakeIntersectionObserver.instances[0]!;
    const element = screen.getByTestId("probe");

    act(() => observer.intersect(element, false));

    expect(screen.getByTestId("probe")).toHaveTextContent("hidden");
  });

  it("disconnects the observer once it has become visible (one-shot)", () => {
    render(<Probe />);
    const observer = FakeIntersectionObserver.instances[0]!;
    const element = screen.getByTestId("probe");

    act(() => observer.intersect(element, true));

    expect(observer.disconnected).toBe(true);
    // A later real disconnect from unmount/cleanup would create a SECOND
    // observer only if a re-render re-ran the effect — asserting there is
    // still just the one instance guards against that.
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it("falls back to visible-immediately when IntersectionObserver is unavailable", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error deliberately removing the global for this test
    delete window.IntersectionObserver;

    render(<Probe />);

    expect(screen.getByTestId("probe")).toHaveTextContent("visible");
  });
});
