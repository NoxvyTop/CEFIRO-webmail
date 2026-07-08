import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function Trigger({ message }: { message: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message)}>
      fire
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("shows a toast as a polite status and auto-dismisses after 2.6s", () => {
    render(
      <ToastProvider>
        <Trigger message="Correo archivado" />
      </ToastProvider>,
    );
    act(() => screen.getByText("fire").click());
    expect(screen.getByRole("status")).toHaveTextContent("Correo archivado");
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("replaces the current toast instead of stacking", () => {
    render(
      <ToastProvider>
        <Trigger message="uno" />
        <Trigger message="dos" />
      </ToastProvider>,
    );
    const [first, second] = screen.getAllByText("fire");
    act(() => first!.click());
    act(() => vi.advanceTimersByTime(1000));
    act(() => second!.click());
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("dos");
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(700));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<Trigger message="x" />)).toThrow(/ToastProvider/);
  });
});
