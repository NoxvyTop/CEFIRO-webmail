import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ToastProvider, useToast } from "./toast";

function Trigger({ message }: { message: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message)}>
      fire
    </button>
  );
}

function ErrorTrigger({ message }: { message: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message, { variant: "error" })}>
      fire error
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

  // #348: every toast rendered role="status" (polite, non-interruptive) even
  // for error copy, auto-dismissed after the same brief 2.6s regardless of
  // content, and offered no dismiss button or way to pause a toast a user was
  // actively reading — so a longer error message could vanish before it was
  // read. The error variant fixes all three.
  describe("error variant", () => {
    it("renders as an assertive alert, not a polite status", () => {
      render(
        <ToastProvider>
          <ErrorTrigger message="No se pudo archivar" />
        </ToastProvider>,
      );
      act(() => screen.getByText("fire error").click());
      expect(screen.getByRole("alert")).toHaveTextContent("No se pudo archivar");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("stays up longer than the default 2.6s", () => {
      render(
        <ToastProvider>
          <ErrorTrigger message="No se pudo archivar" />
        </ToastProvider>,
      );
      act(() => screen.getByText("fire error").click());
      act(() => vi.advanceTimersByTime(2600));
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("offers a dismiss button that closes it immediately", () => {
      render(
        <ToastProvider>
          <ErrorTrigger message="No se pudo archivar" />
        </ToastProvider>,
      );
      act(() => screen.getByText("fire error").click());
      act(() => screen.getByRole("button", { name: /cerrar/i }).click());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("pauses its auto-dismiss timer while hovered, and resumes once unhovered", () => {
      render(
        <ToastProvider>
          <ErrorTrigger message="No se pudo archivar" />
        </ToastProvider>,
      );
      act(() => screen.getByText("fire error").click());
      const alert = screen.getByRole("alert");

      act(() => vi.advanceTimersByTime(3000));
      fireEvent.mouseEnter(alert);
      // Well past the normal auto-dismiss window — still up because hover paused it.
      act(() => vi.advanceTimersByTime(20000));
      expect(screen.getByRole("alert")).toBeInTheDocument();

      fireEvent.mouseLeave(alert);
      act(() => vi.advanceTimersByTime(20000));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
