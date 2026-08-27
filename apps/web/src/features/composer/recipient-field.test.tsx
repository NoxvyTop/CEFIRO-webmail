import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { Contact } from "@webmail/shared";
import { RecipientField } from "./RecipientField";

const { searchContacts } = vi.hoisted(() => ({ searchContacts: vi.fn() }));
vi.mock("../contacts/api", () => ({ searchContacts }));

const ana: Contact = { id: "c1", name: "Ana Lopez", email: "ana@example.com", source: "manual" };
const bob: Contact = { id: "c2", name: "Bob Smith", email: "bob@example.com", source: "manual" };
const zoe: Contact = { id: "c3", name: "Zoe Ruiz", email: "zoe@example.com", source: "harvested" };

beforeEach(() => {
  vi.useFakeTimers();
  searchContacts.mockReset();
  searchContacts.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

async function advanceDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe("RecipientField", () => {
  describe("baseline chip behavior (unchanged)", () => {
    it("adds a chip for a valid typed address on Enter when no suggestion is highlighted", () => {
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "carla@example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onChange).toHaveBeenCalledWith([{ name: null, email: "carla@example.com" }]);
    });

    it("shows an inline hint and does not add a chip for an invalid address", () => {
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "not-an-email" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.getByText(i18n.t("composer.invalidEmail"))).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("removes a chip via its remove button", () => {
      const onChange = vi.fn();
      render(
        <RecipientField
          label="Para"
          value={[{ name: "Bob", email: "bob@example.com" }]}
          onChange={onChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.removeRecipient", { email: "bob@example.com" }) }));

      expect(onChange).toHaveBeenCalledWith([]);
    });
  });

  describe("suggestion search (#124)", () => {
    it("does not call the search endpoint below the minimum query length", async () => {
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "a" } });
      await advanceDebounce();

      expect(searchContacts).not.toHaveBeenCalled();
    });

    it("debounces the search: no request fires immediately, one fires after the pause", async () => {
      searchContacts.mockResolvedValueOnce([ana]);
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "an" } });
      expect(searchContacts).not.toHaveBeenCalled();

      await advanceDebounce();

      expect(searchContacts).toHaveBeenCalledWith("an");
    });

    it("collapses rapid keystrokes into a single debounced request", async () => {
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "a" } });
      fireEvent.change(input, { target: { value: "an" } });
      fireEvent.change(input, { target: { value: "ana" } });

      await advanceDebounce();

      expect(searchContacts).toHaveBeenCalledTimes(1);
      expect(searchContacts).toHaveBeenCalledWith("ana");
    });

    it("shows matching suggestions with both name and address once the debounced search resolves", async () => {
      searchContacts.mockResolvedValueOnce([ana]);
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "an" } });
      await advanceDebounce();

      // Fake timers are active in this file — findBy*/waitFor's own internal
      // polling would stall against the faked clock, so query synchronously;
      // advanceDebounce() has already flushed the resulting state update.
      const option = screen.getByRole("option", { name: /Ana Lopez/ });
      expect(option).toHaveTextContent("Ana Lopez");
      expect(option).toHaveTextContent("ana@example.com");
    });

    it("does not offer a suggestion that is already an added recipient", async () => {
      searchContacts.mockResolvedValueOnce([ana, bob]);
      render(
        <RecipientField
          label="Para"
          value={[{ name: "Ana Lopez", email: "ana@example.com" }]}
          onChange={vi.fn()}
        />,
      );
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "a" + "n" } });
      await advanceDebounce();

      expect(screen.getByRole("option", { name: /Bob Smith/ })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Ana Lopez/ })).not.toBeInTheDocument();
    });

    it("Up/Down navigates the suggestions and Enter selects the highlighted one", async () => {
      searchContacts.mockResolvedValueOnce([ana, bob]);
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "an" } });
      await advanceDebounce();
      screen.getAllByRole("option");

      // Default highlight is the first suggestion (Ana); move down to Bob.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onChange).toHaveBeenCalledWith([{ name: "Bob Smith", email: "bob@example.com" }]);
      // Selecting clears the typed text and the dropdown.
      expect(input).toHaveValue("");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("ArrowUp moves the highlight back up without going above the first suggestion", async () => {
      searchContacts.mockResolvedValueOnce([ana, bob]);
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "an" } });
      await advanceDebounce();
      screen.getAllByRole("option");

      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onChange).toHaveBeenCalledWith([{ name: "Ana Lopez", email: "ana@example.com" }]);
    });

    it("a failed search leaves the field usable and shows no broken UI", async () => {
      searchContacts.mockRejectedValueOnce(new Error("network down"));
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "an" } });
      await advanceDebounce();

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(input).toHaveValue("an");

      // Still usable — typing more keeps working normally.
      fireEvent.change(input, { target: { value: "and" } });
      expect(input).toHaveValue("and");
    });

    it("Escape closes the suggestion list and swallows the key so it never reaches ancestors", async () => {
      searchContacts.mockResolvedValueOnce([ana]);
      const outerHandler = vi.fn();
      window.addEventListener("keydown", outerHandler);
      try {
        render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
        const input = screen.getByRole("combobox", { name: "Para" });

        fireEvent.change(input, { target: { value: "an" } });
        await advanceDebounce();
        screen.getByRole("listbox");

        fireEvent.keyDown(input, { key: "Escape" });

        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        // The composer owns a window-level Escape handler (GH #125) — if the
        // suggestion list doesn't stop propagation, that handler would also
        // fire and close (or discard-confirm) the whole composer.
        expect(outerHandler).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keydown", outerHandler);
      }
    });

    it("lets Escape bubble normally when no suggestion list is open", () => {
      const outerHandler = vi.fn();
      window.addEventListener("keydown", outerHandler);
      try {
        render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
        const input = screen.getByRole("combobox", { name: "Para" });

        fireEvent.keyDown(input, { key: "Escape" });

        expect(outerHandler).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("keydown", outerHandler);
      }
    });

    it("reflects open/highlighted state via aria-expanded and aria-activedescendant", async () => {
      searchContacts.mockResolvedValueOnce([ana]);
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });
      expect(input).toHaveAttribute("aria-expanded", "false");

      fireEvent.change(input, { target: { value: "an" } });
      await advanceDebounce();

      const option = screen.getByRole("option", { name: /Ana Lopez/ });
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    });
  });

  // GH #279: pasting "a@x, b@y" used to make one invalid chip — only Enter and
  // "," split addresses while typing, and a paste bypassed both — and commit()
  // never deduped, so a repeated address minted a second chip under the same
  // React key, which handleRemove would then delete in pairs.
  describe("paste splitting and dedup (#279)", () => {
    function pasteInto(input: HTMLElement, text: string) {
      fireEvent.paste(input, { clipboardData: { getData: () => text } });
    }

    it("splits a comma-separated paste into one chip per address", () => {
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      pasteInto(input, "a@x.com, b@y.com");

      expect(onChange).toHaveBeenCalledWith([
        { name: null, email: "a@x.com" },
        { name: null, email: "b@y.com" },
      ]);
    });

    it("splits on whitespace and semicolons as well as commas", () => {
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      pasteInto(input, "a@x.com b@y.com;c@z.com");

      expect(onChange).toHaveBeenCalledWith([
        { name: null, email: "a@x.com" },
        { name: null, email: "b@y.com" },
        { name: null, email: "c@z.com" },
      ]);
    });

    it("dedups pasted addresses against existing recipients and within the paste itself", () => {
      const onChange = vi.fn();
      render(
        <RecipientField label="Para" value={[{ name: null, email: "a@x.com" }]} onChange={onChange} />,
      );
      const input = screen.getByRole("combobox", { name: "Para" });

      // a@x.com is already a recipient (pasted here upper-cased); b@y.com repeats
      // within the paste. Neither may add a second chip.
      pasteInto(input, "A@x.com, b@y.com, B@y.com");

      expect(onChange).toHaveBeenCalledWith([
        { name: null, email: "a@x.com" },
        { name: null, email: "b@y.com" },
      ]);
    });

    it("adds the valid pasted addresses and leaves the unparseable ones in the input, flagged", () => {
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" }) as HTMLInputElement;

      pasteInto(input, "a@x.com, nope, b@y.com");

      expect(onChange).toHaveBeenCalledWith([
        { name: null, email: "a@x.com" },
        { name: null, email: "b@y.com" },
      ]);
      expect(input.value).toBe("nope");
      expect(screen.getByText(i18n.t("composer.invalidEmail"))).toBeInTheDocument();
    });

    it("leaves a single pasted address for normal typing rather than chipping it", () => {
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      // No separator in the clipboard text: fall through to the browser's own
      // paste so a partial address can still be typed and committed with Enter.
      pasteInto(input, "solo@x.com");

      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not add a duplicate chip when committing an address already present (case-insensitive)", () => {
      const onChange = vi.fn();
      render(
        <RecipientField
          label="Para"
          value={[{ name: "Bob", email: "bob@example.com" }]}
          onChange={onChange}
        />,
      );
      const input = screen.getByRole("combobox", { name: "Para" }) as HTMLInputElement;

      fireEvent.change(input, { target: { value: "BOB@example.com" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onChange).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    });
  });

  // GH #163: an auto-harvested address must not be offered as if the user had
  // vetted it themselves — otherwise a stranger who mailed you once shows up
  // in autocomplete looking exactly like a colleague you added by hand.
  describe("harvested provenance (#163)", () => {
    it("marks an auto-harvested suggestion and leaves a hand-added one unmarked", async () => {
      searchContacts.mockResolvedValueOnce([ana, zoe]);
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "an" } });
      await advanceDebounce();

      expect(screen.getByRole("option", { name: /Zoe Ruiz/ })).toHaveTextContent(
        i18n.t("contacts.harvestedBadge"),
      );
      expect(screen.getByRole("option", { name: /Ana Lopez/ })).not.toHaveTextContent(
        i18n.t("contacts.harvestedBadge"),
      );
    });

    it("carries the origin in the option's accessible name, so it is not conveyed by styling alone", async () => {
      searchContacts.mockResolvedValueOnce([zoe]);
      render(<RecipientField label="Para" value={[]} onChange={vi.fn()} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "zo" } });
      await advanceDebounce();

      // The badge is real text inside the option, so it reaches a screen
      // reader through the option's own accessible name — no colour, border
      // or icon-only cue is load-bearing here.
      const option = screen.getByRole("option", {
        name: new RegExp(i18n.t("contacts.harvestedBadge")),
      });
      expect(option).toHaveTextContent("Zoe Ruiz");
    });

    it("still selects a harvested suggestion normally — marking it is not blocking it", async () => {
      searchContacts.mockResolvedValueOnce([zoe]);
      const onChange = vi.fn();
      render(<RecipientField label="Para" value={[]} onChange={onChange} />);
      const input = screen.getByRole("combobox", { name: "Para" });

      fireEvent.change(input, { target: { value: "zo" } });
      await advanceDebounce();
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onChange).toHaveBeenCalledWith([{ name: "Zoe Ruiz", email: "zoe@example.com" }]);
    });
  });
});
