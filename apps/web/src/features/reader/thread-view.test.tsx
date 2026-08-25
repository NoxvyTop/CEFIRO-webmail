import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useSearchParams } from "react-router";
import type { CustomLabel, ThreadDetail } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { ThreadView } from "./ThreadView";
import { expectNoAxeViolations } from "../../test/axe";

const REMOTE_IMAGE_URL = "https://tracker.evil/pixel.png";

// Typed explicitly (not just inferred) so `cid: null` widens to `string |
// null` instead of narrowing to the `null` literal type — otherwise
// `structuredClone(thread)` copies keep the narrow inferred type, and tests
// that assign a string cid (e.g. inline cid attachment tests below) would
// fail to typecheck.
const thread: ThreadDetail = {
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
      attachments: [{ blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048, cid: null }],
      messageId: ["e1@example.com"],
      references: null,
      inReplyTo: null,
      senderAuth: "unknown",
      senderTrust: "none",
      bodyTruncated: false,
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
      messageId: ["e2@example.com"],
      references: ["e1@example.com"],
      inReplyTo: ["e1@example.com"],
      senderAuth: "unknown",
      senderTrust: "none",
      bodyTruncated: false,
    },
  ],
};

// Applies PATCH updates in place so a refetch after invalidateQueries reflects the mutation,
// mirroring how the real server would respond to a keywords/mailboxIds update.
// Identities the fetch stub reports by default — none of the thread's senders
// match, so every message renders with inbox ("para mí y el equipo") framing
// unless a test overrides identities via stubFetch's second argument.
const NO_IDENTITIES: { id: string; name: string; email: string }[] = [];

function stubFetch(identities = NO_IDENTITIES, customLabels: CustomLabel[] = []) {
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
    if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
    if (url.includes("/api/mail/preferences")) {
      return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels }));
    }
    if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
    if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
    return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Surfaces the current `compose` search param so tests can assert which
// compose action a button click actually triggered (reply/reply-all/forward
// + the target message id) without needing a real composer mounted.
function ComposeParamProbe() {
  const [params] = useSearchParams();
  return <div data-testid="compose-param">{params.get("compose") ?? ""}</div>;
}

function renderThread(
  threadId = "t1",
  archiveMailboxId: string | null = null,
  inboxMailboxId: string | null = null,
  trashMailboxId: string | null = null,
  // GH #13/#50 (G-2): the active shared mailbox this thread is read from —
  // undefined = personal (the default, unchanged for every existing test).
  accountId?: string,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <ThreadView
            threadId={threadId}
            archiveMailboxId={archiveMailboxId}
            inboxMailboxId={inboxMailboxId}
            trashMailboxId={trashMailboxId}
            accountId={accountId}
          />
          <ComposeParamProbe />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Builds a fetch mock whose thread endpoint returns a thread whose last email
// (e2) sits ONLY in the archive mailbox — the state where the reader should
// offer "move back to inbox" instead of "archive".
function stubArchivedThread() {
  const state = structuredClone(thread);
  state.emails[1]!.mailboxIds = ["arch1"];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/mail/messages/") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
    if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
    return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
  });
}

// GH #133: a thread whose last email (e2) sits ONLY in the Trash mailbox —
// the state where the reader should offer "Delete permanently" instead of
// "Delete", mirroring stubArchivedThread() above. Answers DELETE for the
// destroy request the same way a real server would on success; individual
// tests override this default via destroyStatus.
function stubTrashedThread(destroyStatus = 200) {
  const state = structuredClone(thread);
  state.emails[1]!.mailboxIds = ["trash1"];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/mail/messages/") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/mail/messages/") && method === "DELETE") {
      return destroyStatus === 200
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(
            JSON.stringify({ code: "destroy_failed", message: "errors.destroy_failed", traceId: "t1" }),
            { status: destroyStatus },
          );
    }
    if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
    if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
    return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
  });
}

describe("ThreadView", () => {
  it("renders subject of the last email and attachment chip", async () => {
    stubFetch();
    renderThread();

    expect(await screen.findByRole("heading", { name: "Re: Quarterly report" })).toBeInTheDocument();

    expect(await screen.findByText(/report\.pdf/)).toBeInTheDocument();
  });

  it("renders a download link and, for previewable types, a 'Ver' control that opens the in-app viewer", async () => {
    stubFetch();
    renderThread();

    const downloadLink = await screen.findByRole("link", { name: i18n.t("attachments.download") });
    expect(downloadLink).toHaveAttribute(
      "href",
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf&dl=1",
    );

    // "Ver" is a button (not a new-tab link) — it opens AttachmentViewer
    // in-app. Full viewer behavior (image/pdf rendering, print, a11y) is
    // covered in attachment-viewer.test.tsx / attachment-card.test.tsx.
    const viewButton = screen.getByRole("button", { name: i18n.t("attachments.view") });
    expect(viewButton).toHaveAttribute("type", "button");
  });

  it("blocks the remote image by default and unblocks it after clicking load images", async () => {
    stubFetch();
    renderThread();

    const loadImagesButton = await screen.findByRole("button", { name: i18n.t("mail.loadImages") });

    const iframe = (await screen.findByTitle(i18n.t("mail.emailContent"))) as HTMLIFrameElement;
    // GH #270: popup-escape only — still no scripts, still no same-origin.
    expect(iframe.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
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

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    expect(
      within(actionsBar).getByRole("button", { name: i18n.t("composer.forward") }),
    ).toBeInTheDocument();
  });

  it("hides the Archivar action when there is no archive mailbox", async () => {
    stubFetch();
    renderThread("t1", null);

    await screen.findByTestId("thread-actions-bar");
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

  it("shows Responder and Reenviar at the foot of the article — Archivar already lives in the top action bar", async () => {
    stubFetch();
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    expect(within(footer).getByRole("button", { name: i18n.t("composer.reply") })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: i18n.t("composer.forward") })).toBeInTheDocument();
    expect(within(footer).queryByRole("button", { name: i18n.t("mail.archive") })).not.toBeInTheDocument();
    // Default fixture's last email (e2) has no recipients beyond the sender,
    // so "Responder a todos" stays hidden here — covered explicitly by the
    // "reply-all visibility" suite below.
    expect(within(footer).queryByRole("button", { name: i18n.t("composer.replyAll") })).not.toBeInTheDocument();
  });

  it("wires the footer's Reenviar button to openCompose('forward:<id>')", async () => {
    stubFetch();
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    fireEvent.click(within(footer).getByRole("button", { name: i18n.t("composer.forward") }));

    expect(await screen.findByTestId("compose-param")).toHaveTextContent("forward:e2");
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

  describe("relative time in the sender block", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date(2026, 6, 21, 14, 0, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows a same-day email as a local time instead of an absolute date/time string", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.receivedAt = new Date(2026, 6, 21, 11, 5, 0).toISOString();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      expect(await screen.findByText("11:05")).toBeInTheDocument();
    });
  });

  it("keeps action buttons from wrapping and lets the hint shrink so it truncates as a unit", async () => {
    // Reply all only shows up for a multi-recipient last email — give this
    // one two distinct recipients so the button is present to assert on.
    const state = structuredClone(thread);
    state.emails[1]!.to = [
      { name: "Bob", email: "bob@example.com" },
      { name: "Dave", email: "dave@example.com" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      }),
    );
    renderThread("t1", "arch1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    const replyAllButton = within(actionsBar).getByRole("button", { name: i18n.t("composer.replyAll") });
    expect(replyAllButton.className).toContain("whitespace-nowrap");
    expect(replyAllButton.className).toContain("shrink-0");
    const forwardButton = within(actionsBar).getByRole("button", { name: i18n.t("composer.forward") });
    expect(forwardButton.className).toContain("whitespace-nowrap");
    expect(forwardButton.className).toContain("shrink-0");

    const hint = within(actionsBar).getByText(i18n.t("shortcuts.hint"));
    expect(hint.className).toContain("min-w-0");
    expect(hint.className).toContain("truncate");
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

  it("shows Mover a Recibidos (and hides Archivar) when the last email is only in the archive", async () => {
    vi.stubGlobal("fetch", stubArchivedThread());
    renderThread("t1", "arch1", "mb-inbox");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    expect(
      within(actionsBar).getByRole("button", { name: i18n.t("mail.unarchive") }),
    ).toBeInTheDocument();
    expect(
      within(actionsBar).queryByRole("button", { name: i18n.t("mail.archive") }),
    ).not.toBeInTheDocument();
  });

  it("clicking Mover a Recibidos moves the last email back to the inbox mailbox", async () => {
    const fetchMock = stubArchivedThread();
    vi.stubGlobal("fetch", fetchMock);
    renderThread("t1", "arch1", "mb-inbox");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    const unarchiveButton = within(actionsBar).getByRole("button", {
      name: i18n.t("mail.unarchive"),
    });
    fireEvent.click(unarchiveButton);

    const patchCall = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/mail/messages/e2" &&
          (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call).toBeTruthy();
      return call;
    });
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mailboxIds: { "mb-inbox": true } });
  });

  it("hides Mover a Recibidos when there is no inbox mailbox", async () => {
    vi.stubGlobal("fetch", stubArchivedThread());
    renderThread("t1", "arch1", null);

    await screen.findByRole("button", { name: i18n.t("mail.star") });
    expect(
      screen.queryByRole("button", { name: i18n.t("mail.unarchive") }),
    ).not.toBeInTheDocument();
  });

  // GH #13/#50 (G-2): copy a message from a shared mailbox into the member's
  // own personal inbox. The action is offered ONLY while a shared mailbox is
  // active (accountId set) and hidden on the personal mailbox.
  describe("copy to inbox (G-2)", () => {
    function stubSharedThread(copyStatus = 200) {
      const state = structuredClone(thread);
      return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/copy-to-inbox") && method === "POST") {
          return copyStatus === 200
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response(
                JSON.stringify({ code: "copy_failed", message: "errors.copy_failed", traceId: "t1" }),
                { status: copyStatus },
              );
        }
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      });
    }

    it("shows Copiar a mi bandeja when a shared mailbox is active", async () => {
      vi.stubGlobal("fetch", stubSharedThread());
      renderThread("t1", null, null, null, "acc-shared");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).getByRole("button", { name: i18n.t("mail.copyToInbox") }),
      ).toBeInTheDocument();
    });

    it("hides Copiar a mi bandeja on the personal mailbox (no active account)", async () => {
      vi.stubGlobal("fetch", stubSharedThread());
      renderThread(); // no accountId → personal mailbox

      await screen.findByTestId("thread-actions-bar");
      expect(
        screen.queryByRole("button", { name: i18n.t("mail.copyToInbox") }),
      ).not.toBeInTheDocument();
    });

    it("clicking it POSTs to the copy endpoint with the shared accountId and shows a success toast", async () => {
      const fetchMock = stubSharedThread();
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", null, null, null, "acc-shared");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.copyToInbox") }));

      const copyCall = await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input) === "/api/mail/messages/e2/copy-to-inbox?accountId=acc-shared" &&
            (init as RequestInit | undefined)?.method === "POST",
        );
        expect(call).toBeTruthy();
        return call;
      });
      expect(copyCall).toBeTruthy();

      expect(await screen.findByText(i18n.t("mail.copiedToInbox"))).toBeInTheDocument();
    });

    it("shows an error toast when the copy fails", async () => {
      vi.stubGlobal("fetch", stubSharedThread(502));
      renderThread("t1", null, null, null, "acc-shared");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.copyToInbox") }));

      expect(await screen.findByText(i18n.t("mail.errors.copy_failed"))).toBeInTheDocument();
    });
  });

  describe("attachments", () => {
    it("renders the attachments block after the email body, not between the AI card and the body", async () => {
      stubFetch();
      renderThread();

      const body = await screen.findByTitle(i18n.t("mail.emailContent"));
      const attachmentsHeading = await screen.findByText(i18n.t("attachments.count", { count: 1 }));

      // DOCUMENT_POSITION_FOLLOWING set means attachmentsHeading comes after body in the DOM.
      expect(body.compareDocumentPosition(attachmentsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows a pluralized 'N adjuntos' header above the attachment pills", async () => {
      const state = structuredClone(thread);
      state.emails[0]!.attachments = [
        { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048, cid: null },
        { blobId: "b2", name: "logo.png", type: "image/png", size: 1024, cid: null },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      expect(await screen.findByText(i18n.t("attachments.count", { count: 2 }))).toBeInTheDocument();
    });

    it("shows a file-type icon next to each attachment", async () => {
      stubFetch();
      renderThread();

      const attachmentText = await screen.findByText(/report\.pdf/);
      // attachmentText is the innermost <span> holding just the name/size text;
      // its direct parent is the pill that also holds the icon and the links.
      const chip = attachmentText.parentElement;
      expect(chip?.querySelector("svg")).toBeTruthy();
    });

    describe("inline cid attachments", () => {
      it("hides an attachment from the chip list when its cid is referenced by a cid: image in the body, but keeps non-referenced attachments (Gmail behavior)", async () => {
        const state = structuredClone(thread);
        state.emails[0]!.bodyHtml = `<p>See the logo below.</p><img src="cid:logo123">`;
        state.emails[0]!.attachments = [
          { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048, cid: null },
          { blobId: "logo-blob", name: "logo.png", type: "image/png", size: 512, cid: "logo123" },
        ];
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
            if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
            // The inline image resolves successfully, so it renders in the body
            // and is correctly de-duplicated out of the chip list (GH #275: a
            // FAILED fetch is the case that keeps the chip — covered below).
            if (url.includes("/api/mail/blobs/logo-blob")) return new Response(pngBytes, { status: 200 });
            return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
          }),
        );
        renderThread();

        // Only the non-inline attachment remains in the chip count/list.
        expect(await screen.findByText(i18n.t("attachments.count", { count: 1 }))).toBeInTheDocument();
        expect(screen.getByText(/report\.pdf/)).toBeInTheDocument();
        expect(screen.queryByText(/logo\.png/)).not.toBeInTheDocument();
      });

      // GH #275: the flip side of the de-dup above. When a referenced,
      // safe-image cid's blob fetch FAILS, it never renders inline — so hiding
      // its chip too (as the de-dup does) would make the attachment
      // unreachable: no inline render, no download link. EmailBody reports the
      // failure and the chip must reappear so the file stays downloadable.
      it("keeps a cid attachment reachable as a downloadable chip when its inline blob fetch fails", async () => {
        const state = structuredClone(thread);
        state.emails[0]!.bodyHtml = `<p>See the logo below.</p><img src="cid:logo123">`;
        state.emails[0]!.attachments = [
          { blobId: "logo-blob", name: "logo.png", type: "image/png", size: 512, cid: "logo123" },
        ];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
            if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
            // The inline blob fetch fails — the exact GH #275 failure mode.
            if (url.includes("/api/mail/blobs/logo-blob")) {
              return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
            }
            return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
          }),
        );
        renderThread();

        // Optimistically hidden while the fetch is in flight, then the failure
        // brings the chip back so the attachment is still downloadable.
        expect(await screen.findByText(/logo\.png/)).toBeInTheDocument();
        expect(screen.getByText(i18n.t("attachments.count", { count: 1 }))).toBeInTheDocument();
      });

      it("keeps a real image attachment (sent as an actual attachment, not embedded via cid:) in the chip list", async () => {
        const state = structuredClone(thread);
        state.emails[0]!.attachments = [
          { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 2048, cid: null },
          { blobId: "photo-blob", name: "photo.png", type: "image/png", size: 900, cid: "photo123" },
        ];
        // The body never references cid:photo123, so it isn't an inline embed
        // in this email — it stays a regular downloadable attachment.
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
            if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
            return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
          }),
        );
        renderThread();

        expect(await screen.findByText(i18n.t("attachments.count", { count: 2 }))).toBeInTheDocument();
        expect(screen.getByText(/photo\.png/)).toBeInTheDocument();
      });

      // GH #134: a cid: reference only actually renders inline when EmailBody
      // considers the attachment's type a "safe inline image" (see
      // isSafeInlineImage in EmailBody.tsx — a narrow allowlist for security
      // reasons). A cid: reference to any other type (e.g. a PDF invoice
      // referenced via cid:, unusual but real) will NEVER resolve to a
      // rendered image — EmailBody leaves it as a broken <img> icon. Hiding
      // it from the attachment chip list too, purely because *something*
      // referenced its cid, makes the file completely unreachable: not
      // rendered inline, not downloadable. Gmail-style behavior is that an
      // attachment that can't actually be shown inline must still surface as
      // a regular, downloadable attachment below the body.
      it("keeps a cid-referenced attachment in the chip list when its type can never resolve inline", async () => {
        const state = structuredClone(thread);
        state.emails[0]!.bodyHtml = `<p>See the invoice below.</p><img src="cid:doc123">`;
        state.emails[0]!.attachments = [
          { blobId: "doc-blob", name: "invoice.pdf", type: "application/pdf", size: 2048, cid: "doc123" },
        ];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
            if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
            return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
          }),
        );
        renderThread();

        expect(await screen.findByText(i18n.t("attachments.count", { count: 1 }))).toBeInTheDocument();
        expect(screen.getByText(/invoice\.pdf/)).toBeInTheDocument();
      });

      it("passes the email's attachments to EmailBody so the inline cid: image itself resolves to a data: URL", async () => {
        // Regression test for the fix: the body renders inside a fully
        // sandboxed (opaque-origin) iframe that can't send the session
        // cookie, so a plain same-origin /api/mail/blobs/... <img src>
        // would 401 there. EmailBody instead fetches the blob from this
        // (authenticated) parent document and inlines it as a data: URL —
        // the blob URL itself must never end up in the srcdoc.
        const state = structuredClone(thread);
        state.emails[0]!.bodyHtml = `<p>See the logo below.</p><img src="cid:logo123">`;
        state.emails[0]!.attachments = [
          { blobId: "logo-blob", name: "logo.png", type: "image/png", size: 512, cid: "logo123" },
        ];
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
            if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
            if (url.includes("/api/mail/blobs/logo-blob")) return new Response(pngBytes, { status: 200 });
            return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
          }),
        );
        renderThread();

        const iframes = await screen.findAllByTitle(i18n.t("mail.emailContent"));
        await waitFor(() => {
          const srcDocs = iframes.map((iframe) => iframe.getAttribute("srcdoc") ?? "");
          expect(srcDocs.some((doc) => doc.includes("data:image/png;base64,"))).toBe(true);
        });
        const srcDocs = iframes.map((iframe) => iframe.getAttribute("srcdoc") ?? "");
        expect(srcDocs.some((doc) => doc.includes("/api/mail/blobs/logo-blob"))).toBe(false);
        expect(srcDocs.some((doc) => doc.includes("cid:logo123"))).toBe(false);
      });
    });
  });

  describe("sent-message framing", () => {
    it('shows "Para: <recipients>" instead of inbox framing when the sender matches one of the user\'s own identities', async () => {
      const state = structuredClone(thread);
      state.emails[1]!.to = [{ name: "Dave", email: "dave@example.com" }];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) {
            return new Response(JSON.stringify([{ id: "id1", name: "Carol", email: "carol@example.com" }]));
          }
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      expect(await screen.findByText(`${i18n.t("mail.sentTo")} Dave`)).toBeInTheDocument();
      // The sent message (carol@example.com, matching the identity) uses the
      // "Para: <recipients>" framing, not the "<email> · <audience>" framing a
      // received message gets — the other message in the thread (alice, a
      // received email) is unaffected, so the assertion is scoped to carol's
      // line specifically.
      expect(screen.queryByText(/carol@example\.com ·/)).not.toBeInTheDocument();
    });

    it("shows a computed audience (not a fixed string) for a received message", async () => {
      // Neither sender matches an identity, so both messages are "received".
      // Alice's message was addressed to Bob, so its audience is derived from
      // that real recipient — "para Bob" — rather than a hardcoded literal.
      stubFetch([{ id: "id1", name: "Someone Else", email: "someone-else@example.com" }]);
      renderThread();

      expect(await screen.findByText(/alice@example\.com · para Bob/)).toBeInTheDocument();
      // The old hardcoded "para mí y el equipo" literal is gone for good.
      expect(screen.queryByText(/el equipo/)).not.toBeInTheDocument();
    });

    it("counts the account itself in a received message's audience", async () => {
      const state = structuredClone(thread);
      // Alice (not one of my identities) writes to Bob (me) and Dave — a
      // received message where I'm one of several recipients, so the audience
      // is "para mí y Dave".
      state.emails[0]!.to = [
        { name: "Bob", email: "bob@example.com" },
        { name: "Dave", email: "dave@example.com" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) {
            return new Response(JSON.stringify([{ id: "id1", name: "Bob", email: "bob@example.com" }]));
          }
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      expect(await screen.findByText(/alice@example\.com · para mí y Dave/)).toBeInTheDocument();
    });
  });

  // Gmail shows "Reply all" when there is at least one other recipient
  // besides the account itself and the original sender — mirrors
  // replyDraft()'s reply-all `cc` in reply.ts (dedupe(to+cc) minus the
  // account's own identity and minus the sender). These cover the top action
  // bar and the footer, which must both follow the same rule.
  describe("reply-all visibility", () => {
    function stubThreadState(state: ThreadDetail, identities: { id: string; name: string; email: string }[] = []) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
    }

    it("hides Responder a todos in the top bar and footer when the account is the only recipient besides the sender", async () => {
      // from=carol, to=[you] only — reply-all wouldn't add anyone beyond
      // what plain reply (to carol) already covers.
      const state = structuredClone(thread);
      state.emails[1]!.to = [{ name: "Me", email: "me@example.com" }];
      state.emails[1]!.cc = [];
      stubThreadState(state, [{ id: "id1", name: "Me", email: "me@example.com" }]);
      renderThread("t1", "arch1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).queryByRole("button", { name: i18n.t("composer.replyAll") }),
      ).not.toBeInTheDocument();

      const footer = screen.getByTestId("thread-footer-actions");
      expect(within(footer).queryByRole("button", { name: i18n.t("composer.replyAll") })).not.toBeInTheDocument();
    });

    it("hides Responder a todos when the sender cc'd themselves alongside the account", async () => {
      // from=carol, to=[you], cc=[carol] — the sender showing up again in cc
      // doesn't count as a real "other" recipient either.
      const state = structuredClone(thread);
      state.emails[1]!.from = [{ name: "Carol", email: "carol@example.com" }];
      state.emails[1]!.to = [{ name: "Me", email: "me@example.com" }];
      state.emails[1]!.cc = [{ name: "Carol", email: "carol@example.com" }];
      stubThreadState(state, [{ id: "id1", name: "Me", email: "me@example.com" }]);
      renderThread("t1", "arch1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).queryByRole("button", { name: i18n.t("composer.replyAll") }),
      ).not.toBeInTheDocument();
    });

    it("shows Responder a todos in the top bar and footer when a real recipient besides the sender exists", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.to = [{ name: "Bob", email: "bob@example.com" }];
      state.emails[1]!.cc = [{ name: "Dave", email: "dave@example.com" }];
      stubThreadState(state);
      renderThread("t1", "arch1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).getByRole("button", { name: i18n.t("composer.replyAll") }),
      ).toBeInTheDocument();

      const footer = screen.getByTestId("thread-footer-actions");
      expect(within(footer).getByRole("button", { name: i18n.t("composer.replyAll") })).toBeInTheDocument();
    });

    it("still shows Responder a todos after excluding the account's own identity, as long as one other real recipient remains", async () => {
      // to=[Bob, you] — once the account's own identity is excluded, Bob is
      // still a real recipient distinct from the sender, so reply-all IS
      // meaningful (this is the common "sender + you + one other" case).
      const state = structuredClone(thread);
      state.emails[1]!.to = [
        { name: "Bob", email: "bob@example.com" },
        { name: "Me", email: "me@example.com" },
      ];
      state.emails[1]!.cc = [];
      stubThreadState(state, [{ id: "id1", name: "Me", email: "me@example.com" }]);
      renderThread("t1", "arch1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).getByRole("button", { name: i18n.t("composer.replyAll") }),
      ).toBeInTheDocument();
    });

    it("wires the footer's Responder a todos button to openCompose('reply-all:<id>')", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.to = [{ name: "Bob", email: "bob@example.com" }];
      state.emails[1]!.cc = [{ name: "Dave", email: "dave@example.com" }];
      stubThreadState(state);
      renderThread("t1", "arch1");

      const footer = await screen.findByTestId("thread-footer-actions");
      fireEvent.click(within(footer).getByRole("button", { name: i18n.t("composer.replyAll") }));

      expect(await screen.findByTestId("compose-param")).toHaveTextContent("reply-all:e2");
    });

    // GH #174: hasReplyAllRecipient used to be a hand-rolled predicate that
    // claimed to mirror composer/reply.ts's replyDraft() but actually
    // diverged from it whenever a message carried a Reply-To — the old
    // predicate always excluded email.from[0], while replyDraft's "to" is
    // replyTo when present, else from. Every fixture above leaves replyTo
    // empty, so that divergence was never exercised. These two cover both
    // directions of the drift on mailing-list mail (From != Reply-To).
    it("hides Responder a todos when Reply-To is a mailing list and To only repeats that list — reply-all would be identical to plain reply (GH #174)", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.from = [{ name: "Alice", email: "alice@example.com" }];
      state.emails[1]!.replyTo = [{ name: null, email: "list@example.com" }];
      state.emails[1]!.to = [{ name: null, email: "list@example.com" }];
      state.emails[1]!.cc = [];
      stubThreadState(state, [{ id: "id1", name: "Me", email: "me@example.com" }]);
      renderThread("t1", "arch1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).queryByRole("button", { name: i18n.t("composer.replyAll") }),
      ).not.toBeInTheDocument();
    });

    it("shows Responder a todos when Reply-To is a mailing list but the original sender is still a genuine reply-all recipient (GH #174)", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.from = [{ name: "Alice", email: "alice@example.com" }];
      state.emails[1]!.replyTo = [{ name: null, email: "list@example.com" }];
      state.emails[1]!.to = [
        { name: "Me", email: "me@example.com" },
        { name: "Alice", email: "alice@example.com" },
      ];
      state.emails[1]!.cc = [];
      stubThreadState(state, [{ id: "id1", name: "Me", email: "me@example.com" }]);
      renderThread("t1", "arch1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).getByRole("button", { name: i18n.t("composer.replyAll") }),
      ).toBeInTheDocument();
    });
  });

  describe("label apply menu (mirrors the star toggle, applies/removes a keyword on the last email)", () => {
    // GH #102: the apply menu offers only the user's own custom labels now —
    // there is no more canonical/seeded registry, so a name the user never
    // created (e.g. "urgente") must not appear as an option.
    it("opens a menu listing the user's custom labels as unchecked checkboxes, not a former-canonical name", async () => {
      const ventas: CustomLabel = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
      const soporte: CustomLabel = { slug: "soporte", name: "Soporte", color: "#2FB8C4" };
      stubFetch(NO_IDENTITIES, [ventas, soporte]);
      renderThread("t1", "arch1");

      const labelsButton = await screen.findByRole("button", { name: i18n.t("mail.labels") });
      fireEvent.click(labelsButton);

      const menu = await screen.findByRole("menu");
      const ventasItem = await within(menu).findByRole("menuitemcheckbox", { name: "Ventas" });
      expect(ventasItem).toHaveAttribute("aria-checked", "false");
      expect(within(menu).getByRole("menuitemcheckbox", { name: "Soporte" })).toBeInTheDocument();
      expect(within(menu).queryByRole("menuitemcheckbox", { name: "urgente" })).not.toBeInTheDocument();
    });

    it("toggling a custom label applies the keyword and shows it as a chip next to the subject", async () => {
      const ventas: CustomLabel = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
      const fetchMock = stubFetch(NO_IDENTITIES, [ventas]);
      renderThread("t1", "arch1");

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      const menu = await screen.findByRole("menu");
      fireEvent.click(await within(menu).findByRole("menuitemcheckbox", { name: "Ventas" }));

      const patchCall = await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(call).toBeTruthy();
        return call;
      });
      const [, init] = patchCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ keywords: { ventas: true } });

      const heading = await screen.findByRole("heading", { name: "Re: Quarterly report" });
      expect(within(heading.parentElement!).getByText("Ventas")).toBeInTheDocument();
    });

    it("unchecking an applied label removes the keyword and its chip", async () => {
      const ventas: CustomLabel = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
      const state = structuredClone(thread);
      state.emails[1]!.keywords = { ventas: true };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url.includes("/api/mail/messages/") && method === "PATCH") {
            const update = JSON.parse(String(init?.body)) as { keywords?: Record<string, boolean> };
            if (update.keywords) Object.assign(state.emails[1]!.keywords as Record<string, boolean>, update.keywords);
            return new Response(null, { status: 204 });
          }
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
          if (url.includes("/api/mail/preferences")) {
            return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [ventas] }));
          }
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread("t1", "arch1");

      const heading = await screen.findByRole("heading", { name: "Re: Quarterly report" });
      const chipContainer = heading.parentElement!;
      expect(within(chipContainer).getByText("Ventas")).toBeInTheDocument();

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      const menu = await screen.findByRole("menu");
      const ventasItem = await within(menu).findByRole("menuitemcheckbox", { name: "Ventas" });
      expect(ventasItem).toHaveAttribute("aria-checked", "true");
      fireEvent.click(ventasItem);

      // The menu stays open (Gmail-style multi-select) and still lists
      // "Ventas" as an option — only the subject-line chip should disappear.
      await waitFor(() => {
        expect(within(chipContainer).queryByText("Ventas")).not.toBeInTheDocument();
      });
    });

    it("shows an empty-state hint and no menuitemcheckbox items for a fresh user with no custom labels (GH #102)", async () => {
      stubFetch(); // defaults to customLabels: []
      renderThread("t1", "arch1");

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      const menu = await screen.findByRole("menu");

      expect(await within(menu).findByText(i18n.t("mail.noLabelsToApply"))).toBeInTheDocument();
      expect(within(menu).queryAllByRole("menuitemcheckbox")).toHaveLength(0);
    });

    it("lists custom labels with their stored display name and color, and applies them like canonical labels", async () => {
      const ventas: CustomLabel = { slug: "ventas-q3", name: "Ventas Q3", color: "#9B6BDB" };
      const fetchMock = stubFetch(NO_IDENTITIES, [ventas]);
      renderThread("t1", "arch1");

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      const menu = await screen.findByRole("menu");
      const ventasItem = await within(menu).findByRole("menuitemcheckbox", { name: "Ventas Q3" });
      const dot = ventasItem.querySelector("span[aria-hidden='true']");
      expect(dot).toHaveStyle({ background: "#9B6BDB" });

      fireEvent.click(ventasItem);

      const patchCall = await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(call).toBeTruthy();
        return call;
      });
      const [, init] = patchCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ keywords: { "ventas-q3": true } });

      // The menu stays open and still lists "Ventas Q3" as an option, so
      // scope this check to the subject-line chip container specifically.
      const heading = await screen.findByRole("heading", { name: "Re: Quarterly report" });
      expect(within(heading.parentElement!).getByText("Ventas Q3")).toBeInTheDocument();
    });

    it("closes the menu when clicking outside of it", async () => {
      stubFetch();
      renderThread("t1", "arch1");

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      await screen.findByRole("menu");

      fireEvent.mouseDown(document.body);

      await waitFor(() => {
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      });
    });

    // GH #93: thread-actions-bar has overflow-x-hidden — per the CSS spec, a
    // non-"visible" value on one overflow axis forces the other axis to
    // compute as "auto" too, so overflow-y clips right along with it. That
    // clipped the menu, which opens BELOW the button and needs the bar to
    // allow vertical overflow it never gets. The fix renders the menu into a
    // document.body portal so it escapes the bar's overflow entirely.
    describe("portal rendering (GH #93: overflow-x-hidden on thread-actions-bar was clipping the menu)", () => {
      it("renders the open menu outside thread-actions-bar, directly under document.body, while role=menu and its checkboxes keep working", async () => {
        const ventas: CustomLabel = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
        stubFetch(NO_IDENTITIES, [ventas]);
        renderThread("t1", "arch1");

        const actionsBar = await screen.findByTestId("thread-actions-bar");
        fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.labels") }));

        const menu = await screen.findByRole("menu");
        expect(actionsBar.contains(menu)).toBe(false);
        expect(menu.parentElement).toBe(document.body);

        // Portaling changes only where the menu lives in the DOM, not its
        // accessible role/content or the keyword toggle wired to it.
        expect(within(menu).getByRole("menuitemcheckbox", { name: "Ventas" })).toBeInTheDocument();
      });

      it("keeps aria-haspopup and aria-expanded on the trigger button even though the menu itself now renders elsewhere", async () => {
        stubFetch();
        renderThread("t1", "arch1");

        const actionsBar = await screen.findByTestId("thread-actions-bar");
        const labelsButton = within(actionsBar).getByRole("button", { name: i18n.t("mail.labels") });
        expect(labelsButton).toHaveAttribute("aria-haspopup", "menu");
        expect(labelsButton).toHaveAttribute("aria-expanded", "false");

        fireEvent.click(labelsButton);
        await screen.findByRole("menu");
        expect(labelsButton).toHaveAttribute("aria-expanded", "true");
      });

      it("keeps the portaled menu open when mousedown lands on a menu item (click-outside must treat the portal as inside, not just the button)", async () => {
        const ventas: CustomLabel = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
        stubFetch(NO_IDENTITIES, [ventas]);
        renderThread("t1", "arch1");

        fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
        const menu = await screen.findByRole("menu");
        const ventasItem = within(menu).getByRole("menuitemcheckbox", { name: "Ventas" });

        fireEvent.mouseDown(ventasItem);

        expect(screen.getByRole("menu")).toBeInTheDocument();
      });

      it("still shows the empty-state hint with no menuitemcheckbox items when portaled, for a fresh user with no custom labels", async () => {
        stubFetch(); // defaults to customLabels: []
        renderThread("t1", "arch1");

        fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
        const menu = await screen.findByRole("menu");

        expect(menu.parentElement).toBe(document.body);
        expect(await within(menu).findByText(i18n.t("mail.noLabelsToApply"))).toBeInTheDocument();
        expect(within(menu).queryAllByRole("menuitemcheckbox")).toHaveLength(0);
      });
    });
  });

  // Gated by the instance-level "sent with footer" setting (GitHub #86) — off
  // by default so a fresh instance shows no footer until an admin enables it.
  describe("sent-with-footer notice (instance setting, GH #86)", () => {
    function stubThreadWithInstanceFlag(sentWithFooter: boolean) {
      const state = structuredClone(thread);
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      });
    }

    it("hides the footer notice when /api/instance reports sentWithFooter:false (default)", async () => {
      vi.stubGlobal("fetch", stubThreadWithInstanceFlag(false));
      renderThread();

      await screen.findByTestId("thread-footer-actions");
      expect(screen.queryByTestId("sent-with-footer")).not.toBeInTheDocument();
    });

    it("shows the footer notice when /api/instance reports sentWithFooter:true", async () => {
      vi.stubGlobal("fetch", stubThreadWithInstanceFlag(true));
      renderThread();

      const footer = await screen.findByTestId("sent-with-footer");
      expect(within(footer).getByText("CÉFIRO")).toBeInTheDocument();
    });

    it("keeps the footer notice hidden when /api/instance fails (never flashes on for an errored instance)", async () => {
      const state = structuredClone(thread);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
          if (url.includes("/api/mail/preferences")) {
            return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
          }
          if (url.includes("/api/instance")) {
            return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
          }
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      // Reader renders fully; the branding footer stays hidden on the errored flag.
      await screen.findByTestId("thread-footer-actions");
      expect(screen.queryByTestId("sent-with-footer")).not.toBeInTheDocument();
    });
  });

  // GH #42: the design's brand footer carries a muted second line under the
  // sender's name. Its prototype value is a job title, which no real mail
  // carries — the address stands in for it, except where the name line
  // already IS the address.
  describe("brand footer sender line (GH #42)", () => {
    it("shows the sender's address under their name when the name is a display name", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.from = [{ name: "Carol Díaz", email: "carol@example.com" }];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
          if (url.includes("/api/mail/preferences")) {
            return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
          }
          if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      const footer = await screen.findByTestId("thread-footer-sender-address");
      expect(footer).toHaveTextContent("carol@example.com");
    });

    it("omits it when the sender has no display name, so the address is not printed twice", async () => {
      // The default fixture's newest message (e2) has `name: null`, so
      // addressLabel already renders the address as the name line.
      stubFetch();
      renderThread();

      await screen.findByTestId("thread-footer-actions");
      expect(screen.queryByTestId("thread-footer-sender-address")).not.toBeInTheDocument();
    });
  });

  // GH #90: opening a thread used to show every message fully expanded and
  // stacked. Previous, already-read messages now collapse into a one-line
  // stub; the last message and any still-unread message stay expanded.
  describe("message collapse (GH #90)", () => {
    function threeMessageThread(): ThreadDetail {
      return {
        id: "t2",
        emails: [
          {
            id: "m1",
            threadId: "t2",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Alice", email: "alice@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Kickoff",
            receivedAt: "2026-07-01T09:00:00.000Z",
            preview: "Let's get started",
            // Read, not the last message — collapses into a stub.
            keywords: { $seen: true },
            hasAttachment: false,
            size: 100,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "Let's get started with the quarterly plan and align on next steps together.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
          {
            id: "m2",
            threadId: "t2",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Bob", email: "bob@example.com" }],
            to: [{ name: "Alice", email: "alice@example.com" }],
            subject: "Re: Kickoff",
            receivedAt: "2026-07-01T10:00:00.000Z",
            preview: "Sounds good",
            // Unread ($seen absent), not the last message — stays expanded.
            keywords: {},
            hasAttachment: false,
            size: 80,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "Sounds good, I am unread still.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
          {
            id: "m3",
            threadId: "t2",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Alice", email: "alice@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Re: Kickoff",
            receivedAt: "2026-07-01T11:00:00.000Z",
            preview: "Final message",
            // Read, but IS the last message — always stays expanded.
            keywords: { $seen: true },
            hasAttachment: false,
            size: 60,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "This is the last message in the thread.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
        ],
      };
    }

    function stubThreeMessageThread() {
      const state = threeMessageThread();
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      });
    }

    it("collapses a read, non-last message into a stub — its EmailBody is not rendered while collapsed", async () => {
      vi.stubGlobal("fetch", stubThreeMessageThread());
      renderThread("t2");

      const stub = await screen.findByRole("button", {
        name: i18n.t("mail.expandMessage", { sender: "Alice" }),
      });
      expect(within(stub).getByText(/Let's get started/)).toBeInTheDocument();

      // The collapsed message's own full body text is not in the document.
      expect(
        screen.queryByText("Let's get started with the quarterly plan and align on next steps together."),
      ).not.toBeInTheDocument();
    });

    it("keeps the last message and an unread non-last message expanded by default", async () => {
      vi.stubGlobal("fetch", stubThreeMessageThread());
      renderThread("t2");

      // m2 is unread and not last — expanded by default.
      expect(await screen.findByText("Sounds good, I am unread still.")).toBeInTheDocument();
      // m3 is the last message — always expanded, regardless of $seen.
      expect(await screen.findByText("This is the last message in the thread.")).toBeInTheDocument();
    });

    it("expands a collapsed message's full body when its stub is clicked", async () => {
      vi.stubGlobal("fetch", stubThreeMessageThread());
      renderThread("t2");

      const stub = await screen.findByRole("button", {
        name: i18n.t("mail.expandMessage", { sender: "Alice" }),
      });
      fireEvent.click(stub);

      expect(
        await screen.findByText("Let's get started with the quarterly plan and align on next steps together."),
      ).toBeInTheDocument();
    });
  });

  // GH #118: the reader now shows the newest message at the top (oldest at
  // the bottom) instead of the old oldest-first order. GH #119: an expanded
  // message (including the newest one) can be collapsed again by clicking
  // its header — expandMessage() used to only ever add ids to expandedIds,
  // and a render-time `|| isLast` force kept the newest message stuck open
  // regardless of expandedIds.
  describe("newest-first order and collapsible expansion (GH #118, GH #119)", () => {
    function threeMessageThread(): ThreadDetail {
      return {
        id: "t2",
        emails: [
          {
            id: "m1",
            threadId: "t2",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Alice", email: "alice@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Kickoff",
            receivedAt: "2026-07-01T09:00:00.000Z",
            preview: "Let's get started",
            // Read, not the newest message — collapses into a stub.
            keywords: { $seen: true },
            hasAttachment: false,
            size: 100,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "Let's get started with the quarterly plan and align on next steps together.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
          {
            id: "m2",
            threadId: "t2",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Bob", email: "bob@example.com" }],
            to: [{ name: "Alice", email: "alice@example.com" }],
            subject: "Re: Kickoff",
            receivedAt: "2026-07-01T10:00:00.000Z",
            preview: "Sounds good",
            // Unread ($seen absent), not the newest message — stays expanded.
            keywords: {},
            hasAttachment: false,
            size: 80,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "Sounds good, I am unread still.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
          {
            id: "m3",
            threadId: "t2",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Alice", email: "alice@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Re: Kickoff",
            receivedAt: "2026-07-01T11:00:00.000Z",
            preview: "Final message",
            // Read, but IS the newest message — expanded by default, must
            // still be collapsible (the GH #119 regression).
            keywords: { $seen: true },
            hasAttachment: false,
            size: 60,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "This is the newest message in the thread.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
        ],
      };
    }

    function stubThreeMessageThread() {
      const state = threeMessageThread();
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      });
    }

    it("renders the newest message before older messages in the DOM", async () => {
      vi.stubGlobal("fetch", stubThreeMessageThread());
      renderThread("t2");

      const newestText = await screen.findByText("This is the newest message in the thread.");
      const middleText = await screen.findByText("Sounds good, I am unread still.");
      const oldestStub = await screen.findByRole("button", {
        name: i18n.t("mail.expandMessage", { sender: "Alice" }),
      });

      expect(newestText.compareDocumentPosition(middleText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(middleText.compareDocumentPosition(oldestStub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("collapses the newest message when its header is clicked, even though it is expanded by default (GH #119 regression)", async () => {
      vi.stubGlobal("fetch", stubThreeMessageThread());
      renderThread("t2");

      await screen.findByText("This is the newest message in the thread.");
      // Before collapsing, only m1 (already read, not newest) is a stub.
      expect(
        screen.getAllByRole("button", { name: i18n.t("mail.expandMessage", { sender: "Alice" }) }),
      ).toHaveLength(1);

      const collapseButton = await screen.findByRole("button", {
        name: i18n.t("mail.collapseMessage", { sender: "Alice" }),
      });
      fireEvent.click(collapseButton);

      await waitFor(() => {
        expect(screen.queryByText("This is the newest message in the thread.")).not.toBeInTheDocument();
      });
      // Collapsing the newest message turns it into a second "Alice" stub.
      expect(
        screen.getAllByRole("button", { name: i18n.t("mail.expandMessage", { sender: "Alice" }) }),
      ).toHaveLength(2);
    });

    it("expands a collapsed message again once its stub is re-clicked, restoring its full body", async () => {
      vi.stubGlobal("fetch", stubThreeMessageThread());
      renderThread("t2");

      await screen.findByText("This is the newest message in the thread.");
      fireEvent.click(
        await screen.findByRole("button", { name: i18n.t("mail.collapseMessage", { sender: "Alice" }) }),
      );

      const stubs = await screen.findAllByRole("button", {
        name: i18n.t("mail.expandMessage", { sender: "Alice" }),
      });
      const newestStub = stubs.find((button) => button.textContent?.includes("This is the newest message"));
      expect(newestStub).toBeTruthy();
      fireEvent.click(newestStub!);

      expect(await screen.findByText("This is the newest message in the thread.")).toBeInTheDocument();
    });

    it("keeps a single-message thread expanded with no collapse affordance", async () => {
      const state: ThreadDetail = {
        id: "t4",
        emails: [
          {
            id: "solo",
            threadId: "t4",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Alice", email: "alice@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Solo message",
            receivedAt: "2026-07-01T09:00:00.000Z",
            preview: "Just me",
            keywords: { $seen: true },
            hasAttachment: false,
            size: 40,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "This thread only has one message.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
        ],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
          if (url.includes("/api/mail/preferences")) {
            return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
          }
          if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread("t4");

      expect(await screen.findByText("This thread only has one message.")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: i18n.t("mail.collapseMessage", { sender: "Alice" }) }),
      ).not.toBeInTheDocument();
    });

    it("reseeds expand state fresh when switching to a different thread, so the new thread's newest message is expanded even after collapsing the previous thread's newest message", async () => {
      const t2 = threeMessageThread();
      const t3: ThreadDetail = {
        id: "t3",
        emails: [
          {
            id: "n1",
            threadId: "t3",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Eve", email: "eve@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Budget",
            receivedAt: "2026-07-02T09:00:00.000Z",
            preview: "Numbers attached",
            keywords: { $seen: true },
            hasAttachment: false,
            size: 40,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "Here is the budget spreadsheet summary for review.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
          {
            id: "n2",
            threadId: "t3",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Bob", email: "bob@example.com" }],
            to: [{ name: "Eve", email: "eve@example.com" }],
            subject: "Re: Budget",
            receivedAt: "2026-07-02T10:00:00.000Z",
            preview: "Looks fine",
            keywords: { $seen: true },
            hasAttachment: false,
            size: 30,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "This is the newest message in the second thread.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
        ],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
          if (url.includes("/api/mail/preferences")) {
            return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
          }
          if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
          if (url.includes("/api/mail/threads/t2")) return new Response(JSON.stringify(t2));
          if (url.includes("/api/mail/threads/t3")) return new Response(JSON.stringify(t3));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { rerender } = render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ToastProvider>
              <ThreadView threadId="t2" archiveMailboxId={null} inboxMailboxId={null} />
            </ToastProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      await screen.findByText("This is the newest message in the thread.");
      fireEvent.click(
        await screen.findByRole("button", { name: i18n.t("mail.collapseMessage", { sender: "Alice" }) }),
      );
      await waitFor(() => {
        expect(screen.queryByText("This is the newest message in the thread.")).not.toBeInTheDocument();
      });

      rerender(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ToastProvider>
              <ThreadView threadId="t3" archiveMailboxId={null} inboxMailboxId={null} />
            </ToastProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(await screen.findByText("This is the newest message in the second thread.")).toBeInTheDocument();
    });

    // Both halves of the same collapse/expand disclosure control need to
    // agree with each other — a screen reader user toggling a message must
    // hear its state confirmed regardless of which half (stub or header)
    // they are currently looking at.
    describe("aria-expanded state", () => {
      it("exposes aria-expanded=false on a collapsed stub's button", async () => {
        vi.stubGlobal("fetch", stubThreeMessageThread());
        renderThread("t2");

        const stub = await screen.findByRole("button", {
          name: i18n.t("mail.expandMessage", { sender: "Alice" }),
        });
        expect(stub).toHaveAttribute("aria-expanded", "false");
      });

      it("exposes aria-expanded=true on an expanded message's header button", async () => {
        vi.stubGlobal("fetch", stubThreeMessageThread());
        renderThread("t2");

        const header = await screen.findByRole("button", {
          name: i18n.t("mail.collapseMessage", { sender: "Alice" }),
        });
        expect(header).toHaveAttribute("aria-expanded", "true");
      });

      it("flips aria-expanded on the same logical control as it is collapsed and re-expanded", async () => {
        vi.stubGlobal("fetch", stubThreeMessageThread());
        renderThread("t2");

        const header = await screen.findByRole("button", {
          name: i18n.t("mail.collapseMessage", { sender: "Alice" }),
        });
        expect(header).toHaveAttribute("aria-expanded", "true");

        fireEvent.click(header);

        const stubs = await screen.findAllByRole("button", {
          name: i18n.t("mail.expandMessage", { sender: "Alice" }),
        });
        const collapsedControl = stubs.find((button) => button.textContent?.includes("This is the newest message"));
        expect(collapsedControl).toBeTruthy();
        expect(collapsedControl).toHaveAttribute("aria-expanded", "false");

        fireEvent.click(collapsedControl!);

        const reExpandedHeader = await screen.findByRole("button", {
          name: i18n.t("mail.collapseMessage", { sender: "Alice" }),
        });
        expect(reExpandedHeader).toHaveAttribute("aria-expanded", "true");
      });
    });
  });

  // GH #162: the effect that seeds expandedIds used to bail out early on any
  // refetch of an already-initialized thread ("if
  // (initializedThreadIdRef.current === threadId) return;") — meant to stop
  // a refetch from re-collapsing a message the user had opened, but it also
  // meant a genuinely new message id (arriving mid-session, e.g. via
  // useMailEvents' blanket ["mail"] invalidation on every server event) was
  // never added to expandedIds. Since the reply/reply-all/forward footer,
  // the AI summary card, and the elevated-card treatment all live behind
  // isNewest *inside* the isExpanded branch, that silently collapsed the
  // newest message and took all of them off screen with it.
  describe("live-arriving messages while the thread stays open (GH #162)", () => {
    function twoMessageThread(): ThreadDetail {
      return {
        id: "t5",
        emails: [
          {
            id: "p1",
            threadId: "t5",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Alice", email: "alice@example.com" }],
            to: [{ name: "Bob", email: "bob@example.com" }],
            subject: "Ongoing",
            receivedAt: "2026-07-01T09:00:00.000Z",
            preview: "Older",
            keywords: { $seen: true },
            hasAttachment: false,
            size: 40,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "The first message in this thread.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
          {
            id: "p2",
            threadId: "t5",
            mailboxIds: ["mb-inbox"],
            from: [{ name: "Bob", email: "bob@example.com" }],
            to: [{ name: "Alice", email: "alice@example.com" }],
            subject: "Re: Ongoing",
            receivedAt: "2026-07-01T10:00:00.000Z",
            preview: "Was newest",
            keywords: { $seen: true },
            hasAttachment: false,
            size: 40,
            cc: [],
            replyTo: [],
            bodyHtml: null,
            bodyText: "The second message, newest until p3 lands.",
            attachments: [],
            messageId: null,
            references: null,
            inReplyTo: null,
            senderAuth: "unknown",
            senderTrust: "none",
            bodyTruncated: false,
          },
        ],
      };
    }

    function thirdMessage(): ThreadDetail["emails"][number] {
      return {
        id: "p3",
        threadId: "t5",
        mailboxIds: ["mb-inbox"],
        from: [{ name: "Carol", email: "carol@example.com" }],
        to: [{ name: "Alice", email: "alice@example.com" }],
        subject: "Re: Ongoing",
        receivedAt: "2026-07-01T11:00:00.000Z",
        preview: "Just landed",
        keywords: {},
        hasAttachment: false,
        size: 40,
        cc: [],
        replyTo: [],
        bodyHtml: null,
        bodyText: "A brand new reply that just arrived.",
        attachments: [],
        messageId: null,
        references: null,
        inReplyTo: null,
        senderAuth: "unknown",
        senderTrust: "none",
        bodyTruncated: false,
      };
    }

    it("expands a newly arrived newest message on a same-thread refetch — including its reply/reply-all/forward footer — without reopening a message the user explicitly collapsed", async () => {
      const state = twoMessageThread();
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ToastProvider>
              <ThreadView threadId="t5" archiveMailboxId={null} inboxMailboxId={null} />
            </ToastProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // p2 starts expanded (it's the newest on initial load) — the user
      // collapses it by hand, which must survive the refetch below.
      await screen.findByRole("button", { name: i18n.t("mail.collapseMessage", { sender: "Bob" }) });
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("mail.collapseMessage", { sender: "Bob" }) }),
      );
      await screen.findByRole("button", { name: i18n.t("mail.expandMessage", { sender: "Bob" }) });

      // p3 arrives — same threadId, just a refetch of the same thread query
      // (mirrors useMailEvents' blanket ["mail"] invalidation firing on
      // every server event while the thread stays open).
      state.emails.push(thirdMessage());
      client.invalidateQueries({ queryKey: ["mail"] });

      // The new message is both newest and unread, so it must auto-expand —
      // a collapse-header button (only rendered while expanded) proves it
      // did not land as a collapsed stub.
      expect(
        await screen.findByRole("button", { name: i18n.t("mail.collapseMessage", { sender: "Carol" }) }),
      ).toBeInTheDocument();
      const footer = await screen.findByTestId("thread-footer-actions");
      expect(within(footer).getByRole("button", { name: i18n.t("composer.reply") })).toBeInTheDocument();

      // p2's user-driven collapse must survive the refetch — the fix only
      // admits the genuinely new id, it must never re-seed already-known ones.
      expect(
        screen.getByRole("button", { name: i18n.t("mail.expandMessage", { sender: "Bob" }) }),
      ).toBeInTheDocument();
    });
  });

  // GH #94: branded (Céfiro logo) loading indicator mounted ON TOP of the
  // thread query's already-existing pending state — before this change the
  // reader pane just rendered blank (`return null`) while the thread loaded.
  describe("loading state (branded Céfiro loader, GH #94)", () => {
    it("shows the CefiroLoader, centered in the reader pane, while the thread query is still loading", async () => {
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
      renderThread();

      const loading = await screen.findByTestId("thread-loading");
      const status = within(loading).getByRole("status");
      expect(status).toHaveAccessibleName(i18n.t("mail.loading"));
      expect(within(loading).getByText(i18n.t("mail.loading"))).toBeInTheDocument();
    });

    it("hides the loader once the thread data has arrived", async () => {
      stubFetch();
      renderThread();

      await screen.findByRole("heading", { name: "Re: Quarterly report" });
      // Scoped to the ThreadView-level loader specifically (not just any
      // role="status" in the tree) — the loaded thread's attachment renders
      // its own compact CefiroLoader as PdfThumbnail's fallback, which stays
      // visible here since pdf.js never actually resolves in this test.
      expect(screen.queryByTestId("thread-loading")).not.toBeInTheDocument();
    });

    it("does not show the loader once the thread query has errored (keeps the existing alert branch)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/mail/threads/")) {
            return new Response(
              JSON.stringify({ code: "mail_not_configured", message: "x", traceId: "t1" }),
              { status: 503 },
            );
          }
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread();

      await screen.findByRole("alert");
      expect(screen.queryByTestId("thread-loading")).not.toBeInTheDocument();
    });
  });

  // GH #92: the last message gets a subtle visual highlight — a real border
  // on an elevated bg-panel card with shadow-card — so it stands out from
  // earlier (or collapsed) messages above it.
  describe("last-message highlight (GH #92)", () => {
    it("gives the last message's container a border + panel + shadow-card treatment", async () => {
      stubFetch();
      renderThread();

      const lastBody = await screen.findByText("Thanks, looks good!");
      const article = lastBody.closest("article");
      expect(article).not.toBeNull();
      expect(article?.className).toMatch(/\bshadow-card\b/);
      expect(article?.className).toMatch(/\bbg-panel\b/);
      expect(article?.className).toMatch(/\bborder\b/);
    });

    it("does not apply the highlight treatment to an earlier (non-last) message", async () => {
      stubFetch();
      renderThread();

      const attachmentText = await screen.findByText(/report\.pdf/);
      const article = attachmentText.closest("article");
      expect(article).not.toBeNull();
      expect(article?.className).not.toMatch(/shadow-card/);
    });
  });

  // GH #133: Delete moves the last email to Trash (recoverable, no
  // confirmation, just feedback — mirrors archiveMutation). Delete
  // permanently is offered ONLY while viewing Trash and always requires
  // explicit confirmation before anything is destroyed.
  describe("delete and delete permanently (GH #133)", () => {
    it("hides the Delete action when the account has no trash mailbox", async () => {
      stubFetch();
      renderThread("t1", "arch1", null, null);

      await screen.findByTestId("thread-actions-bar");
      expect(screen.queryByRole("button", { name: i18n.t("mail.delete") })).not.toBeInTheDocument();
    });

    it("shows the Delete action in the action bar when a trash mailbox exists", async () => {
      stubFetch();
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(within(actionsBar).getByRole("button", { name: i18n.t("mail.delete") })).toBeInTheDocument();
    });

    it("clicking Delete moves the last email to the trash mailbox with no confirmation and shows feedback", async () => {
      const fetchMock = stubFetch();
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.delete") }));

      // No confirmation dialog for a move to Trash — it's recoverable.
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      const patchCall = await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(call).toBeTruthy();
        return call;
      });
      const [, init] = patchCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ mailboxIds: { trash1: true } });

      expect(await screen.findByText(i18n.t("mail.deleted"))).toBeInTheDocument();
    });

    it("hides Delete permanently when a trash mailbox exists but the thread is not being viewed from Trash", async () => {
      stubFetch();
      renderThread("t1", "arch1", null, "trash1");

      await screen.findByTestId("thread-actions-bar");
      expect(
        screen.queryByRole("button", { name: i18n.t("mail.deletePermanently") }),
      ).not.toBeInTheDocument();
    });

    it("shows Delete permanently (and hides Delete) when the last email is only in Trash", async () => {
      vi.stubGlobal("fetch", stubTrashedThread());
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      expect(
        within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }),
      ).toBeInTheDocument();
      expect(
        within(actionsBar).queryByRole("button", { name: i18n.t("mail.delete") }),
      ).not.toBeInTheDocument();
    });

    it("clicking Delete permanently opens a confirmation dialog naming the message, without destroying anything yet", async () => {
      const fetchMock = stubTrashedThread();
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));

      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText(/Re: Quarterly report/)).toBeInTheDocument();
      // GH #253: the focus trap (#158) kept Tab inside, but without aria-modal
      // a screen reader's virtual cursor still roamed the page behind an
      // irreversible destroy confirmation.
      expect(dialog).toHaveAttribute("aria-modal", "true");

      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE"),
      ).toBe(false);
    });

    it("dismissing the confirmation with Cancel destroys nothing", async () => {
      const fetchMock = stubTrashedThread();
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));
      const dialog = await screen.findByRole("alertdialog");

      fireEvent.click(
        within(dialog).getByRole("button", { name: i18n.t("mail.deletePermanentlyConfirm.cancel") }),
      );

      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE"),
      ).toBe(false);
    });

    it("dismissing the confirmation with Escape destroys nothing", async () => {
      const fetchMock = stubTrashedThread();
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));
      await screen.findByRole("alertdialog");

      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE"),
      ).toBe(false);
    });

    it("dismissing the confirmation by clicking the backdrop destroys nothing", async () => {
      const fetchMock = stubTrashedThread();
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));
      const dialog = await screen.findByRole("alertdialog");

      fireEvent.click(dialog);

      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE"),
      ).toBe(false);
    });

    it("confirming Delete permanently issues the destroy request, closes the dialog and shows feedback", async () => {
      const fetchMock = stubTrashedThread();
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: i18n.t("mail.deletePermanentlyConfirm.confirm") }),
      );

      await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "DELETE",
        );
        expect(call).toBeTruthy();
      });

      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
      expect(await screen.findByText(i18n.t("mail.deletedPermanently"))).toBeInTheDocument();
    });

    it("keeps the confirmation open and shows an error when the server refuses to destroy the message", async () => {
      const fetchMock = stubTrashedThread(409);
      vi.stubGlobal("fetch", fetchMock);
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: i18n.t("mail.deletePermanentlyConfirm.confirm") }),
      );

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        i18n.t("mail.errors.destroy_failed"),
      );
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    // GH #158: reproduced in the browser as Tab walking off the last button,
    // through <body>, and into background page elements (the header logo)
    // while this alertdialog still covers the screen — right next to an
    // irreversible action. Now backed by the shared useFocusTrap primitive.
    it("traps Tab focus inside the confirmation instead of letting it escape to the page", async () => {
      vi.stubGlobal("fetch", stubTrashedThread());
      renderThread("t1", "arch1", null, "trash1");

      const actionsBar = await screen.findByTestId("thread-actions-bar");
      fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));
      const dialog = await screen.findByRole("alertdialog");

      expect(dialog.contains(document.activeElement)).toBe(true);

      const confirmButton = within(dialog).getByRole("button", {
        name: i18n.t("mail.deletePermanentlyConfirm.confirm"),
      });
      confirmButton.focus();
      fireEvent.keyDown(window, { key: "Tab" });

      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: i18n.t("mail.deletePermanentlyConfirm.cancel") }),
      );
    });
  });
});

// GH #136: sender-authenticity indicator, wired into the sender header of
// the expanded (newest) message. The badge component's own rendering rules
// (icon choice, accessible name per verdict, nothing for "unknown") are
// covered in sender-auth-badge.test.tsx — these tests only check that
// ThreadView actually renders it from the last email's `senderAuth` field.
describe("sender authentication badge (GH #136)", () => {
  function stubThreadWithSenderAuth(senderAuth: ThreadDetail["emails"][number]["senderAuth"]) {
    const state = structuredClone(thread);
    state.emails[1]!.senderAuth = senderAuth;
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
      if (url.includes("/api/mail/preferences")) {
        return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
      }
      if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    });
  }

  it("shows the pass mark, with its full accessible-name meaning, when the last email's senderAuth is 'pass'", async () => {
    vi.stubGlobal("fetch", stubThreadWithSenderAuth("pass"));
    renderThread();

    expect(
      await screen.findByRole("img", { name: i18n.t("mail.senderAuth.passLabel") }),
    ).toBeInTheDocument();
  });

  it("shows the warning mark, with its full accessible-name meaning, when the last email's senderAuth is 'fail'", async () => {
    vi.stubGlobal("fetch", stubThreadWithSenderAuth("fail"));
    renderThread();

    expect(
      await screen.findByRole("img", { name: i18n.t("mail.senderAuth.failLabel") }),
    ).toBeInTheDocument();
  });

  it("renders each verdict distinctly: pass and fail never share the same accessible name", async () => {
    vi.stubGlobal("fetch", stubThreadWithSenderAuth("pass"));
    renderThread();
    await screen.findByRole("img", { name: i18n.t("mail.senderAuth.passLabel") });
    expect(screen.queryByRole("img", { name: i18n.t("mail.senderAuth.failLabel") })).not.toBeInTheDocument();
  });

  it("shows no authenticity mark at all when senderAuth is 'unknown' — never a positive mark by default", async () => {
    vi.stubGlobal("fetch", stubThreadWithSenderAuth("unknown"));
    renderThread();

    await screen.findByRole("heading", { name: "Re: Quarterly report" });
    expect(screen.queryByRole("img", { name: i18n.t("mail.senderAuth.passLabel") })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: i18n.t("mail.senderAuth.failLabel") })).not.toBeInTheDocument();
  });

  // The mark must be impossible for a sender to forge via their own display
  // name: it renders exclusively from the server-provided senderAuth
  // verdict, never from `from.name`/addressLabel. A checkmark-like character
  // in the display name must show up only as plain text, never as (or
  // instead of) the real authenticity mark.
  it("does not render a pass mark from a checkmark in the sender's display name when senderAuth is 'unknown'", async () => {
    const state = structuredClone(thread);
    state.emails[1]!.senderAuth = "unknown";
    state.emails[1]!.from = [{ name: "✓ Verified Sender", email: "carol@example.com" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      }),
    );
    renderThread();

    // The forged checkmark is visible as ordinary sender-name text...
    expect(await screen.findByText("✓ Verified Sender")).toBeInTheDocument();
    // ...but it never produces (or is read as) the real authenticity mark.
    expect(screen.queryByRole("img", { name: i18n.t("mail.senderAuth.passLabel") })).not.toBeInTheDocument();
  });

  // Same forged-display-name scenario, but with a server-confirmed 'fail' —
  // proves the forged checkmark can't even mask a genuine warning.
  it("still shows the real warning mark (not the spoofed checkmark) when a forged display name coincides with senderAuth 'fail'", async () => {
    const state = structuredClone(thread);
    state.emails[1]!.senderAuth = "fail";
    state.emails[1]!.from = [{ name: "✓ Verified Sender", email: "carol@example.com" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
        if (url.includes("/api/mail/preferences")) {
          return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
        }
        if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
        if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      }),
    );
    renderThread();

    expect(
      await screen.findByRole("img", { name: i18n.t("mail.senderAuth.failLabel") }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: i18n.t("mail.senderAuth.passLabel") })).not.toBeInTheDocument();
  });
});

// GH #214: the action bar is a single 52px row of shrink-0 whitespace-nowrap
// buttons. It used to be overflow-x-hidden, so on a 375px phone — worst case
// Archive, in Spanish, where the row wants ~450px inside ~331px of usable
// width — Eliminar and Etiquetas were clipped away with nothing to scroll them
// back into view.
describe("ThreadView action bar at a narrow viewport (GH #214)", () => {
  const NARROW_VIEWPORT_WIDTH = 375;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: NARROW_VIEWPORT_WIDTH,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    });
    vi.unstubAllGlobals();
  });

  it("makes the overflow scrollable instead of clipping it away", async () => {
    vi.stubGlobal("fetch", stubArchivedThread());
    renderThread("t1", "arch1", "inbox1", "trash1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    expect(actionsBar.className).toContain("overflow-x-auto");
    expect(actionsBar.className).not.toContain("overflow-x-hidden");
  });

  it("keeps every action of the worst-case (Archive) row reachable", async () => {
    vi.stubGlobal("fetch", stubArchivedThread());
    renderThread("t1", "arch1", "inbox1", "trash1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    for (const name of [
      i18n.t("mail.unarchive"),
      i18n.t("mail.delete"),
      i18n.t("mail.star"),
      i18n.t("composer.reply"),
      i18n.t("composer.forward"),
      i18n.t("mail.labels"),
    ]) {
      expect(within(actionsBar).getByRole("button", { name })).toBeVisible();
    }
  });

  it("still fires the two actions the clipping used to swallow", async () => {
    const fetchMock = stubArchivedThread();
    vi.stubGlobal("fetch", fetchMock);
    renderThread("t1", "arch1", "inbox1", "trash1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.delete") }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/mail/messages/") && init?.method === "PATCH",
        ),
      ).toBe(true);
    });
  });

  it("still opens the label popover, which the hidden overflow was there for", async () => {
    vi.stubGlobal("fetch", stubArchivedThread());
    renderThread("t1", "arch1", "inbox1", "trash1");

    const labelsButton = await screen.findByRole("button", { name: i18n.t("mail.labels") });
    fireEvent.click(labelsButton);

    // Portaled to document.body, so it escapes the bar's overflow entirely —
    // which is why the bar no longer has to hide that axis on its account.
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(document.querySelector('[data-testid="thread-actions-bar"]')?.contains(menu)).toBe(false);
  });
});

// GH #249: the sibling row #214 did not touch. The reply row at the foot of
// the last message is Responder / Responder a todos / Reenviar — in Spanish
// ~400px of buttons inside the ~335px the reader column has on a 375px phone —
// and it had no flex-wrap, no shrink-0 and no scrollable axis, so Reenviar was
// simply pushed off the edge with no way back.
describe("ThreadView footer reply row at a narrow viewport (GH #249)", () => {
  const NARROW_VIEWPORT_WIDTH = 375;
  const originalInnerWidth = window.innerWidth;

  function stubReplyAllThread() {
    // to + cc beyond the sender, so the worst case (all three buttons) renders.
    const state = structuredClone(thread);
    state.emails[1]!.to = [{ name: "Bob", email: "bob@example.com" }];
    state.emails[1]!.cc = [{ name: "Dave", email: "dave@example.com" }];
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    });
  }

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: NARROW_VIEWPORT_WIDTH,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    });
    vi.unstubAllGlobals();
  });

  it("wraps the row instead of letting it run off the edge", async () => {
    vi.stubGlobal("fetch", stubReplyAllThread());
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    expect(footer.className).toContain("flex-wrap");
  });

  it("wraps between buttons rather than squeezing their labels", async () => {
    vi.stubGlobal("fetch", stubReplyAllThread());
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    const buttons = within(footer).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.className).toContain("shrink-0");
    }
  });

  it("keeps every action of the worst-case (reply-all) row reachable", async () => {
    vi.stubGlobal("fetch", stubReplyAllThread());
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    for (const name of [
      i18n.t("composer.reply"),
      i18n.t("composer.replyAll"),
      i18n.t("composer.forward"),
    ]) {
      expect(within(footer).getByRole("button", { name })).toBeVisible();
    }
  });

  it("still fires the action the overflow used to swallow", async () => {
    vi.stubGlobal("fetch", stubReplyAllThread());
    renderThread("t1", "arch1");

    const footer = await screen.findByTestId("thread-footer-actions");
    fireEvent.click(within(footer).getByRole("button", { name: i18n.t("composer.forward") }));

    expect(await screen.findByTestId("compose-param")).toHaveTextContent("forward:e2");
  });
});

// GH #227: the mutation path used to invalidate the whole ["mail"] namespace
// on every archive/delete/star, sweeping identities, preferences, signatures
// and every already-loaded page of the infinite listing. These pin the exact
// key set each mutation invalidates, so a future edit can't quietly widen it
// back — the same cost GH #167 removed from the SSE path in useMailEvents.
describe("ThreadView cache invalidation (GH #227)", () => {
  const MAILBOX_MOVE_KEYS = [
    ["mail", "messages"],
    ["mail", "thread"],
    ["mail", "mailboxes"],
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWithInvalidationSpy(
    archiveMailboxId: string | null = null,
    inboxMailboxId: string | null = null,
    trashMailboxId: string | null = null,
  ) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ToastProvider>
            <ThreadView
              threadId="t1"
              archiveMailboxId={archiveMailboxId}
              inboxMailboxId={inboxMailboxId}
              trashMailboxId={trashMailboxId}
            />
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return invalidateQueries;
  }

  type InvalidateSpy = { mock: { calls: unknown[][] } };

  function invalidatedKeys(spy: InvalidateSpy): unknown[] {
    return spy.mock.calls.map((call) => (call[0] as { queryKey?: unknown } | undefined)?.queryKey);
  }

  it("invalidates only messages, thread and mailboxes when archiving", async () => {
    stubFetch();
    const spy = renderWithInvalidationSpy("arch1", null, "trash1");

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.archive") }));

    await waitFor(() => expect(invalidatedKeys(spy)).toEqual(MAILBOX_MOVE_KEYS));
  });

  it("invalidates the same narrow set when deleting to Trash", async () => {
    stubFetch();
    const spy = renderWithInvalidationSpy("arch1", null, "trash1");

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.delete") }));

    await waitFor(() => expect(invalidatedKeys(spy)).toEqual(MAILBOX_MOVE_KEYS));
  });

  it("invalidates the same narrow set when moving back to the inbox", async () => {
    vi.stubGlobal("fetch", stubArchivedThread());
    const spy = renderWithInvalidationSpy("arch1", "inbox1", "trash1");

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.unarchive") }));

    await waitFor(() => expect(invalidatedKeys(spy)).toEqual(MAILBOX_MOVE_KEYS));
  });

  it("invalidates the same narrow set when destroying permanently", async () => {
    vi.stubGlobal("fetch", stubTrashedThread());
    const spy = renderWithInvalidationSpy("arch1", "inbox1", "trash1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    fireEvent.click(
      within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }),
    );
    // The bar's trigger and the dialog's confirm share the same label, so the
    // confirm has to be looked up inside the dialog.
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: i18n.t("mail.deletePermanentlyConfirm.confirm") }),
    );

    await waitFor(() => expect(invalidatedKeys(spy)).toEqual(MAILBOX_MOVE_KEYS));
  });

  it("never sweeps the whole mail namespace, nor preferences/identities", async () => {
    stubFetch();
    const spy = renderWithInvalidationSpy("arch1", null, "trash1");

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.archive") }));

    await waitFor(() => expect(invalidatedKeys(spy).length).toBeGreaterThan(0));
    const keys = invalidatedKeys(spy);
    expect(keys).not.toContainEqual(["mail"]);
    expect(keys).not.toContainEqual(["mail", "preferences"]);
    expect(keys).not.toContainEqual(["mail", "identities"]);
  });

  it("keeps starring narrowed to this thread and the listings", async () => {
    stubFetch();
    const spy = renderWithInvalidationSpy("arch1", null, "trash1");

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.star") }));

    await waitFor(() =>
      expect(invalidatedKeys(spy)).toEqual([
        ["mail", "thread", "t1"],
        ["mail", "messages"],
      ]),
    );
  });
});

// GH #252: the reader, checked by the real engine. It is the screen with the
// most ARIA surface per pixel — an expandable message stack, a sanitized HTML
// body, a label popover, an action bar and a destructive confirmation.
describe("ThreadView accessibility (GH #252)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes an axe run over the open thread", async () => {
    stubFetch();
    renderThread("t1", "arch1", "inbox1", "trash1");

    await screen.findByTestId("thread-footer-actions");
    await expectNoAxeViolations(document.body);
  });

  it("passes an axe run with the destructive confirmation open", async () => {
    vi.stubGlobal("fetch", stubTrashedThread());
    renderThread("t1", "arch1", null, "trash1");

    const actionsBar = await screen.findByTestId("thread-actions-bar");
    fireEvent.click(within(actionsBar).getByRole("button", { name: i18n.t("mail.deletePermanently") }));

    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body);
  });
});

// GH #140: JMAP cut the body at the fetch budget and the flag was thrown away,
// so the reader showed a message ending mid-sentence with nothing saying it was
// incomplete. The notice must reach the user on whichever body path renders.
describe("truncated body notice (GH #140)", () => {
  function stubTruncatedThread(bodyTruncated: boolean, asPlainText = false) {
    const state = structuredClone(thread);
    const target = state.emails[1]!;
    target.bodyTruncated = bodyTruncated;
    if (!asPlainText) {
      target.bodyHtml = "<p>A very long message that stops right here";
      target.bodyText = null;
    }
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
      if (url.includes("/api/mail/preferences")) {
        return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
      }
      if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    });
  }

  it("tells the user the message is incomplete when the body was truncated", async () => {
    vi.stubGlobal("fetch", stubTruncatedThread(true));
    renderThread();

    expect(await screen.findByText(i18n.t("mail.bodyTruncated.title"))).toBeInTheDocument();
  });

  it("warns that replying will carry the truncation into the thread", async () => {
    vi.stubGlobal("fetch", stubTruncatedThread(true));
    renderThread();

    expect(await screen.findByText(i18n.t("mail.bodyTruncated.hint"))).toBeInTheDocument();
  });

  it("shows the notice on the plain-text body path too, not only the HTML one", async () => {
    vi.stubGlobal("fetch", stubTruncatedThread(true, true));
    renderThread();

    expect(await screen.findByText(i18n.t("mail.bodyTruncated.title"))).toBeInTheDocument();
  });

  it("stays silent for a complete message", async () => {
    vi.stubGlobal("fetch", stubTruncatedThread(false));
    renderThread();

    await screen.findByRole("heading", { name: "Re: Quarterly report" });
    expect(screen.queryByText(i18n.t("mail.bodyTruncated.title"))).not.toBeInTheDocument();
  });
});

// GH #314: the sender-trust badge and the "Trust this service" affordance,
// wired into the expanded (newest) message. The badge's own rendering rules
// per tier are covered in sender-trust-badge.test.tsx; these tests check that
// ThreadView renders it from the last email's `senderTrust` next to the real
// address, and that the trust/untrust actions call the right endpoints and
// refresh the thread so the badge flips.
describe("sender trust badge and trust-this-service action (GH #314)", () => {
  type TrustState = ThreadDetail["emails"][number]["senderTrust"];
  type AuthState = ThreadDetail["emails"][number]["senderAuth"];

  // A fetch stub whose thread endpoint reflects trust/untrust mutations: a PUT
  // flips the last email to "trusted-service", a DELETE flips it back to
  // "none", exactly as the real server would after invalidation refetches.
  function stubTrustThread(input: {
    senderAuth: AuthState;
    senderTrust: TrustState;
    userList?: string[];
    putStatus?: number;
  }) {
    const state = structuredClone(thread);
    const last = state.emails[1];
    if (!last) throw new Error("fixture must carry a second (newest) email");
    last.senderAuth = input.senderAuth;
    last.senderTrust = input.senderTrust;
    let userList = [...(input.userList ?? [])];
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      const method = init?.method ?? "GET";
      const prefix = "/api/mail/trusted-services/";
      if (url.startsWith(prefix) && method === "PUT") {
        if (input.putStatus && input.putStatus !== 200) {
          return new Response(JSON.stringify({ code: "invalid_domain" }), { status: input.putStatus });
        }
        userList.push(decodeURIComponent(url.slice(prefix.length)));
        last.senderTrust = "trusted-service";
        return new Response(JSON.stringify({ seed: ["github.com"], user: userList }));
      }
      if (url.startsWith(prefix) && method === "DELETE") {
        const domain = decodeURIComponent(url.slice(prefix.length));
        userList = userList.filter((entry) => entry !== domain);
        last.senderTrust = "none";
        return new Response(JSON.stringify({ seed: ["github.com"], user: userList }));
      }
      if (url === "/api/mail/trusted-services") {
        return new Response(JSON.stringify({ seed: ["github.com"], user: userList }));
      }
      if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(NO_IDENTITIES));
      if (url.includes("/api/mail/preferences")) {
        return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
      }
      if (url.includes("/api/instance")) return new Response(JSON.stringify({ sentWithFooter: false }));
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  // The last email (e2) is from carol@example.com — the address the badge and
  // the action must name.
  const knownLabel = () => i18n.t("mail.senderTrust.knownLabel", { address: "carol@example.com" });
  const trustedLabel = () => i18n.t("mail.senderTrust.trustedServiceLabel", { domain: "example.com" });
  const trustAction = () => i18n.t("mail.senderTrust.trustAction", { domain: "example.com" });
  const untrustAction = () => i18n.t("mail.senderTrust.untrustAction", { domain: "example.com" });

  it("shows the known-sender mark, naming the real address, when senderTrust is 'known'", async () => {
    stubTrustThread({ senderAuth: "pass", senderTrust: "known" });
    renderThread();

    expect(await screen.findByRole("img", { name: knownLabel() })).toBeInTheDocument();
    // The authenticity mark it sits next to is still rendered, not replaced.
    expect(screen.getByRole("img", { name: i18n.t("mail.senderAuth.passLabel") })).toBeInTheDocument();
    // And the real address is printed in the header, next to the marks.
    expect(screen.getAllByText(/carol@example\.com/).length).toBeGreaterThan(0);
  });

  it("shows the trusted-service mark, naming the real domain, when senderTrust is 'trusted-service'", async () => {
    stubTrustThread({ senderAuth: "pass", senderTrust: "trusted-service" });
    renderThread();

    expect(await screen.findByRole("img", { name: trustedLabel() })).toBeInTheDocument();
  });

  it("shows no trust mark and no action when senderTrust is 'none' and the sender is unauthenticated", async () => {
    stubTrustThread({ senderAuth: "unknown", senderTrust: "none" });
    renderThread();

    await screen.findByRole("heading", { name: "Re: Quarterly report" });
    expect(screen.queryByRole("img", { name: knownLabel() })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: trustedLabel() })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: trustAction() })).not.toBeInTheDocument();
  });

  it("offers no trust action on a DMARC fail — nothing may vouch for a spoofed message", async () => {
    stubTrustThread({ senderAuth: "fail", senderTrust: "none" });
    renderThread();

    await screen.findByRole("img", { name: i18n.t("mail.senderAuth.failLabel") });
    expect(screen.queryByRole("button", { name: trustAction() })).not.toBeInTheDocument();
  });

  it("offers 'Trust <domain>' for an authenticated but untrusted sender, and flips the badge after PUT", async () => {
    const fetchMock = stubTrustThread({ senderAuth: "pass", senderTrust: "none" });
    renderThread();

    fireEvent.click(await screen.findByRole("button", { name: trustAction() }));

    expect(await screen.findByRole("img", { name: trustedLabel() })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/trusted-services/example.com", { method: "PUT" });
    // The affordance is gone now that the domain is trusted.
    expect(screen.queryByRole("button", { name: trustAction() })).not.toBeInTheDocument();
  });

  it("offers 'Stop trusting <domain>' only when the domain is on the USER list, and flips back after DELETE", async () => {
    const fetchMock = stubTrustThread({
      senderAuth: "pass",
      senderTrust: "trusted-service",
      userList: ["example.com"],
    });
    renderThread();

    fireEvent.click(await screen.findByRole("button", { name: untrustAction() }));

    expect(await screen.findByRole("button", { name: trustAction() })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/trusted-services/example.com", { method: "DELETE" });
    expect(screen.queryByRole("img", { name: trustedLabel() })).not.toBeInTheDocument();
  });

  it("offers no untrust action for a domain trusted through the seed (not per-user removable)", async () => {
    stubTrustThread({ senderAuth: "pass", senderTrust: "trusted-service", userList: [] });
    renderThread();

    await screen.findByRole("img", { name: trustedLabel() });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: untrustAction() })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: trustAction() })).not.toBeInTheDocument();
  });

  it("offers no trust action for a known sender — Tier A is a fact, not a preference", async () => {
    stubTrustThread({ senderAuth: "pass", senderTrust: "known" });
    renderThread();

    await screen.findByRole("img", { name: knownLabel() });
    expect(screen.queryByRole("button", { name: trustAction() })).not.toBeInTheDocument();
  });

  it("reports a refused PUT through the mapped error message and keeps the action available", async () => {
    stubTrustThread({ senderAuth: "pass", senderTrust: "none", putStatus: 400 });
    renderThread();

    fireEvent.click(await screen.findByRole("button", { name: trustAction() }));

    expect(await screen.findByText(i18n.t("mail.errors.invalid_domain"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: trustAction() })).toBeInTheDocument();
  });
});
