import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AiSummaryCard } from "./AiSummaryCard";

function renderCard(messageId = "e1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiSummaryCard messageId={messageId} />
    </QueryClientProvider>,
  );
}

describe("AiSummaryCard", () => {
  it("shows a button initially and requests the summary only when clicked", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    const button = await screen.findByRole("button", { name: i18n.t("mail.summarizeWithAi") });
    expect(fetchMock).not.toHaveBeenCalled();
    // The idle trigger is always wrapped in the full-width card (border-line/bg-soft),
    // not a standalone compact pill — the card frame is present before any click.
    expect(button.closest(".bg-soft")).toBeInTheDocument();

    fireEvent.click(button);

    const loading = await screen.findByText(i18n.t("mail.aiSummaryLoading"));
    expect(loading).toBeInTheDocument();
    // CLARO-02: accent used as small text needs the AA-safe --accent-text
    // token in light theme, not the raw --accent fill color.
    expect(loading.closest("p")).toHaveClass("text-accent-text");
    expect(screen.queryByRole("region", { name: i18n.t("mail.aiSummaryTitle") })).not.toBeInTheDocument();

    resolveFetch(new Response(JSON.stringify({ bullets: ["a", "b", "c"] })));

    expect(await screen.findByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: i18n.t("mail.aiSummaryTitle") })).toBeInTheDocument();
  });

  it("hides itself entirely when the backend reports ai_disabled", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "ai_disabled" }), { status: 501 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    const button = await screen.findByRole("button", { name: i18n.t("mail.summarizeWithAi") });
    fireEvent.click(button);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: i18n.t("mail.summarizeWithAi") })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: i18n.t("mail.aiSummaryTitle") })).not.toBeInTheDocument();
  });

  it("shows an inline error for a provider failure without hiding permanently", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "ai_provider_error" }), { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    const button = await screen.findByRole("button", { name: i18n.t("mail.summarizeWithAi") });
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("mail.errors.ai_provider_error"));
  });
});
