import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { ThreadView } from "./ThreadView";

const REMOTE_IMAGE_URL = "https://tracker.evil/pixel.png";

const thread = {
  id: "t1",
  emails: [
    {
      id: "e1",
      threadId: "t1",
      mailboxIds: ["mb-inbox"],
      from: [{ name: "Alice", email: "alice@example.com" }],
      to: [{ name: "Bob", email: "bob@example.com" }],
      subject: "Quarterly report",
      receivedAt: "2026-07-01T10:00:00.000Z",
      preview: "preview one",
      keywords: {},
      hasAttachment: true,
      size: 2048,
      cc: [],
      replyTo: [],
      bodyHtml: `<p>Here is the report.</p><img src="${REMOTE_IMAGE_URL}">`,
      bodyText: null,
      attachments: [{ blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048 }],
    },
    {
      id: "e2",
      threadId: "t1",
      mailboxIds: ["mb-inbox"],
      from: [{ name: null, email: "carol@example.com" }],
      to: [],
      subject: "Re: Quarterly report",
      receivedAt: "2026-07-01T11:00:00.000Z",
      preview: "preview two",
      keywords: {},
      hasAttachment: false,
      size: 50,
      cc: [],
      replyTo: [],
      bodyHtml: null,
      bodyText: "Thanks, looks good!",
      attachments: [],
    },
  ],
};

// Applies PATCH updates in place so a refetch after invalidateQueries reflects the mutation,
// mirroring how the real server would respond to a keywords/mailboxIds update.
function stubFetch() {
  const state = structuredClone(thread);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/mail/messages/") && method === "PATCH") {
      const id = url.split("/").pop();
      const update = JSON.parse(String(init?.body)) as {
        keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean>;
      };
      const email = state.emails.find((candidate) => candidate.id === id);
      if (email) {
        if (update.keywords) Object.assign(email.keywords as Record<string, boolean>, update.keywords);
        if (update.mailboxIds) {
          email.mailboxIds = Object.entries(update.mailboxIds)
            .filter(([, present]) => present)
            .map(([mailboxId]) => mailboxId);
        }
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
    return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderThread(threadId = "t1", archiveMailboxId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <ThreadView threadId={threadId} archiveMailboxId={archiveMailboxId} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ThreadView", () => {
  it("renders subject of the last email and attachment chip", async () => {
    stubFetch();
    renderThread();

    expect(await screen.findByRole("heading", { name: "Re: Quarterly report" })).toBeInTheDocument();

    expect(await screen.findByText(/report\.pdf/)).toBeInTheDocument();
  });

  it("renders a download link and, for previewable types, a view link", async () => {
    stubFetch();
    renderThread();

    const downloadLink = await screen.findByRole("link", { name: i18n.t("attachments.download") });
    expect(downloadLink).toHaveAttribute(
      "href",
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf&dl=1",
    );

    const viewLink = screen.getByRole("link", { name: i18n.t("attachments.view") });
    expect(viewLink).toHaveAttribute("href", "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf");
    expect(viewLink).toHaveAttribute("target", "_blank");
  });

  it("blocks the remote image by default and unblocks it after clicking load images", async () => {
    stubFetch();
    renderThread();

    const loadImagesButton = await screen.findByRole("button", { name: i18n.t("mail.loadImages") });

    const iframe = (await screen.findByTitle(i18n.t("mail.emailContent"))) as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("srcdoc")).not.toContain(REMOTE_IMAGE_URL);

    fireEvent.click(loadImagesButton);

    const updatedIframe = (await screen.findByTitle(i18n.t("mail.emailContent"))) as HTMLIFrameElement;
    expect(updatedIframe.getAttribute("srcdoc")).toContain(REMOTE_IMAGE_URL);
  });

  it("renders a text-only email body in a pre element", async () => {
    stubFetch();
    renderThread();

    const textNode = await screen.findByText("Thanks, looks good!");
    expect(textNode.tagName).toBe("PRE");
  });

  it("renders a Forward button for the last email", async () => {
    stubFetch();
    renderThread();

    expect(
      await screen.findByRole("button", { name: i18n.t("composer.forward") }),
    ).toBeInTheDocument();
  });

  it("hides the Archivar action when there is no archive mailbox", async () => {
    stubFetch();
    renderThread("t1", null);

    await screen.findByRole("button", { name: i18n.t("composer.forward") });
    expect(screen.queryByRole("button", { name: i18n.t("mail.archive") })).not.toBeInTheDocument();
  });

  it("shows Archivar and Destacar in the action bar when an archive mailbox exists", async () => {
    stubFetch();
    renderThread("t1", "arch1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    expect(within(actionsBar).getByRole("button", { name: i18n.t("mail.archive") })).toBeInTheDocument();
    expect(within(actionsBar).getByRole("button", { name: i18n.t("mail.star") })).toBeInTheDocument();
  });

  it("clicking Archivar moves the last email to the archive mailbox", async () => {
    const fetchMock = stubFetch();
    renderThread("t1", "arch1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    const archiveButton = within(actionsBar).getByRole("button", { name: i18n.t("mail.archive") });
    fireEvent.click(archiveButton);

    const patchCall = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call).toBeTruthy();
      return call;
    });
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mailboxIds: { arch1: true } });
  });

  it("clicking Destacar toggles $flagged on the last email", async () => {
    const fetchMock = stubFetch();
    renderThread("t1", "arch1");

    const starButton = await screen.findByRole("button", { name: i18n.t("mail.star") });
    fireEvent.click(starButton);

    await screen.findByRole("button", { name: i18n.t("mail.unstar") });
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ keywords: { $flagged: true } });
  });

  it("shows Responder and Archivar buttons at the foot of the article", async () => {
    stubFetch();
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    expect(within(footer).getByRole("button", { name: i18n.t("composer.reply") })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: i18n.t("mail.archive") })).toBeInTheDocument();
  });

  it("shows the sender's label chips next to the title", async () => {
    const state = structuredClone(thread);
    state.emails[1]!.keywords = { producto: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      }),
    );
    renderThread();

    expect(await screen.findByText("producto")).toBeInTheDocument();
  });

  it("hides Archivar when the last email is already in the archive mailbox", async () => {
    const state = structuredClone(thread);
    state.emails[1]!.mailboxIds = ["arch1"];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/mail/messages/") && method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderThread("t1", "arch1");

    await screen.findByRole("button", { name: i18n.t("mail.star") });
    expect(screen.queryByRole("button", { name: i18n.t("mail.archive") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("mail.star") })).toBeInTheDocument();
  });
});
