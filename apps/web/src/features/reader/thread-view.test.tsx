import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import type { CustomLabel, ThreadDetail } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { ThreadView } from "./ThreadView";

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

        // Only the non-inline attachment remains in the chip count/list.
        expect(await screen.findByText(i18n.t("attachments.count", { count: 1 }))).toBeInTheDocument();
        expect(screen.getByText(/report\.pdf/)).toBeInTheDocument();
        expect(screen.queryByText(/logo\.png/)).not.toBeInTheDocument();
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
      // The sent message (carol@example.com, matching the identity) no longer
      // uses the raw "<email> · para mí y el equipo" framing — the other
      // message in the thread (alice, a received email) is unaffected and
      // keeps it, so the assertion is scoped to carol's line specifically.
      expect(screen.queryByText(/carol@example\.com ·/)).not.toBeInTheDocument();
    });

    it("keeps the inbox framing for a received message when identities don't match the sender", async () => {
      stubFetch([{ id: "id1", name: "Someone Else", email: "someone-else@example.com" }]);
      renderThread();

      expect(await screen.findByText(new RegExp(i18n.t("mail.toMeAndTeam")))).toBeInTheDocument();
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
