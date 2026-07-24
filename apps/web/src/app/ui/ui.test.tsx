import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, avatarColor, initials } from "./Avatar";
import { CefiroLogo } from "./CefiroLogo";

describe("avatarColor", () => {
  it("is deterministic and case-insensitive", () => {
    expect(avatarColor("carla@noxvytop.com")).toBe(avatarColor("CARLA@noxvytop.com"));
  });

  it("returns a color from the design palette", () => {
    expect(avatarColor("x@y.com")).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe("initials", () => {
  it("uses first and second word initials from the name", () => {
    expect(initials("Carla Bosch", "carla@noxvytop.com")).toBe("CB");
  });

  it("falls back to the email when the name is empty", () => {
    expect(initials(null, "lucia.ferrer@noxvytop.com")).toBe("LF");
    expect(initials("  ", "solo@noxvytop.com")).toBe("SN");
  });
});

describe("components", () => {
  it("renders the avatar initials", () => {
    render(<Avatar name="Carla Bosch" email="carla@noxvytop.com" />);
    expect(screen.getByText("CB")).toBeInTheDocument();
  });

  it("renders a photo instead of initials when imageUrl is provided", () => {
    const { container } = render(
      <Avatar
        name="Carla Bosch"
        email="carla@noxvytop.com"
        imageUrl="data:image/png;base64,AAAA"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.queryByText("CB")).not.toBeInTheDocument();
  });

  it("falls back to initials when imageUrl is null", () => {
    const { container } = render(
      <Avatar name="Carla Bosch" email="carla@noxvytop.com" imageUrl={null} />,
    );
    expect(screen.getByText("CB")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to initials when imageUrl is absent", () => {
    const { container } = render(<Avatar name="Carla Bosch" email="carla@noxvytop.com" />);
    expect(screen.getByText("CB")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the logo as decorative svg", () => {
    const { container } = render(<CefiroLogo size={72} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "72");
  });
});
