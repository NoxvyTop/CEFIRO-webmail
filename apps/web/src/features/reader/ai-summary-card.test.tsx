import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AiSummaryCard } from "./AiSummaryCard";
import { summaryStorageKey, writeCachedSummary } from "./summaryCache";

function renderCard(
  props: { messageId?: string; threadId?: string; messageCount?: number; emailIds?: string[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiSummaryCard
        messageId={props.messageId ?? "e1"}
        threadId={props.threadId ?? "t1"}
        messageCount={props.messageCount ?? 1}
        emailIds={props.emailIds}
      />
    </QueryClientProvider>,
  );
}

// The card now persists generated summaries to localStorage (#308), which is
// shared across every test in this jsdom worker — clear it so a summary written
// by one test can't make the next one skip its "Resumir" trigger.
beforeEach(() => {
  localStorage.clear();
});

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

  it("tells a timed-out provider apart from one that answered badly", async () => {
    // GH #165: the server emits upstream_timeout (504) specifically so these
    // two stay distinguishable. If the card folded it into the generic error,
    // the distinction would die at the last step — and the user would not know
    // that this one is worth retrying straight away.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: "upstream_timeout" }), { status: 504 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    const button = await screen.findByRole("button", { name: i18n.t("mail.summarizeWithAi") });
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("mail.errors.upstream_timeout"));
    // A raw key leaking to the screen is the failure mode this guards (GH #150).
    expect(alert.textContent).not.toContain("mail.errors.");
    expect(alert).not.toHaveTextContent(i18n.t("mail.errors.generic"));
  });
});

describe("AiSummaryCard — thread mode", () => {
  it("calls the thread summarize endpoint and labels itself as a conversation summary when there is more than one message", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["x", "y"] })));
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ threadId: "t1", messageCount: 3 });

    const button = await screen.findByRole("button", { name: i18n.t("mail.summarizeConversation") });
    expect(screen.queryByRole("button", { name: i18n.t("mail.summarizeWithAi") })).not.toBeInTheDocument();
    fireEvent.click(button);

    expect(await screen.findByText("x")).toBeInTheDocument();
    expect(screen.getByText("y")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/threads/t1/summarize", { method: "POST" });
  });

  it("uses the single-message endpoint and label when there is only one message", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["z"] })));
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ messageId: "e1", messageCount: 1 });

    const button = await screen.findByRole("button", { name: i18n.t("mail.summarizeWithAi") });
    fireEvent.click(button);

    expect(await screen.findByText("z")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/e1/summarize", { method: "POST" });
  });
});

describe("AiSummaryCard — localStorage cache (#308)", () => {
  it("survives a reload: a generated summary re-shows on a fresh mount with no new fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["r1", "r2"] })));
    vi.stubGlobal("fetch", fetchMock);

    // First "session": generate the summary — the click writes it to the cache.
    const first = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.summarizeWithAi") }));
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // A "reload" is a brand-new QueryClient — React Query's in-session cache is
    // gone, so only localStorage can re-show the summary.
    renderCard();
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("r2")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: i18n.t("mail.aiSummaryTitle") })).toBeInTheDocument();
    // Restored from localStorage — no second round-trip, and no "Resumir" click.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: i18n.t("mail.summarizeWithAi") }),
    ).not.toBeInTheDocument();
  });

  it("renders a cached message summary immediately without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    writeCachedSummary(
      summaryStorageKey({ isThread: false, messageId: "e1", threadId: "t1", messageCount: 1 }),
      ["seeded-1", "seeded-2"],
    );

    renderCard();

    expect(await screen.findByText("seeded-1")).toBeInTheDocument();
    expect(screen.getByText("seeded-2")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-shows a thread summary when the message set is unchanged", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    writeCachedSummary(
      summaryStorageKey({
        isThread: true, threadId: "t1", messageId: "e2", messageCount: 2, emailIds: ["e1", "e2"],
      }),
      ["thread-cached"],
    );

    renderCard({ threadId: "t1", messageCount: 2, emailIds: ["e1", "e2"], messageId: "e2" });

    expect(await screen.findByText("thread-cached")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("misses and re-offers Resumir when the thread's message set has changed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["fresh"] })));
    vi.stubGlobal("fetch", fetchMock);
    // A summary persisted for the OLD id set...
    writeCachedSummary(
      summaryStorageKey({
        isThread: true, threadId: "t1", messageId: "e2", messageCount: 2, emailIds: ["e1", "e2"],
      }),
      ["old-summary"],
    );

    // ...but the thread has since grown a reply (e3): a different id set → miss.
    renderCard({ threadId: "t1", messageCount: 3, emailIds: ["e1", "e2", "e3"], messageId: "e3" });

    expect(
      await screen.findByRole("button", { name: i18n.t("mail.summarizeConversation") }),
    ).toBeInTheDocument();
    expect(screen.queryByText("old-summary")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes the cache when regenerating under a new thread key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bullets: ["regenerated"] })));
    vi.stubGlobal("fetch", fetchMock);

    // The grown thread (e1,e2,e3) misses the old cache and offers Resumir.
    const grown = renderCard({
      threadId: "t1", messageCount: 3, emailIds: ["e1", "e2", "e3"], messageId: "e3",
    });
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.summarizeConversation") }));
    expect(await screen.findByText("regenerated")).toBeInTheDocument();
    grown.unmount();

    // A reload of the same (grown) thread now re-shows the regenerated summary
    // from localStorage, with no further fetch.
    fetchMock.mockClear();
    renderCard({ threadId: "t1", messageCount: 3, emailIds: ["e1", "e2", "e3"], messageId: "e3" });
    expect(await screen.findByText("regenerated")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
