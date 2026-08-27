import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders the primary variant with the filled accent classes", () => {
    render(<Button variant="primary">Send</Button>);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveClass("bg-accent");
    expect(button).toHaveClass("text-accent-ink");
    expect(button).toHaveClass("shadow-cta");
  });

  it("renders the secondary variant with the outlined classes", () => {
    render(<Button variant="secondary">Discard</Button>);
    const button = screen.getByRole("button", { name: "Discard" });
    expect(button).toHaveClass("border");
    expect(button).toHaveClass("border-line-strong");
    expect(button).not.toHaveClass("bg-accent");
  });

  it("defaults to the secondary variant when none is specified", () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole("button", { name: "Default" });
    expect(button).toHaveClass("border-line-strong");
    expect(button).not.toHaveClass("bg-accent");
  });

  it("defaults the native type to button", () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole("button", { name: "Click" })).toHaveAttribute("type", "button");
  });

  it("forwards an explicit type override", () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole("button", { name: "Submit" })).toHaveAttribute("type", "submit");
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Click" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards disabled and never fires onClick when clicked while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Click
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Click" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("merges a caller-supplied className alongside the variant classes without dropping either", () => {
    render(
      <Button variant="primary" className="rounded-[11px] px-[22px]">
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveClass("bg-accent");
    expect(button).toHaveClass("rounded-[11px]");
    expect(button).toHaveClass("px-[22px]");
  });

  it("forwards standard aria attributes such as aria-label", () => {
    render(<Button aria-label="Close dialog">X</Button>);
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
  });
});
