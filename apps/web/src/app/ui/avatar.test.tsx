import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

// GH #282: the admin user list builds rows from an avatar URL, and a photo
// removed between building the list and painting it (GH #205) used to leave a
// broken-image icon. The <img> now falls back to the initials block on `error`.
describe("Avatar", () => {
  it("renders the photo when an image URL is given", () => {
    render(<Avatar name="Carla Bosch" email="carla@example.com" imageUrl="/api/admin/users/u1/avatar" />);

    const img = document.body.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/api/admin/users/u1/avatar");
    expect(screen.queryByText("CB")).not.toBeInTheDocument();
  });

  it("falls back to initials when the image fails to load (404)", () => {
    render(<Avatar name="Carla Bosch" email="carla@example.com" imageUrl="/api/admin/users/u1/avatar" />);

    fireEvent.error(document.body.querySelector("img") as HTMLImageElement);

    expect(document.body.querySelector("img")).toBeNull();
    expect(screen.getByText("CB")).toBeInTheDocument();
  });

  it("renders initials directly when there is no image URL", () => {
    render(<Avatar name="Ana" email="ana@example.com" />);

    expect(screen.getByText("A")).toBeInTheDocument();
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("gives a new image URL a fresh attempt after a previous one failed", () => {
    const { rerender } = render(
      <Avatar name="Carla Bosch" email="carla@example.com" imageUrl="/avatars/old" />,
    );
    fireEvent.error(document.body.querySelector("img") as HTMLImageElement);
    expect(document.body.querySelector("img")).toBeNull();

    rerender(<Avatar name="Carla Bosch" email="carla@example.com" imageUrl="/avatars/new" />);

    const img = document.body.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/avatars/new");
  });
});
