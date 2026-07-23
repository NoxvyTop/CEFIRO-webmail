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
  });

  describe("label apply menu (mirrors the star toggle, applies/removes a keyword on the last email)", () => {
    it("opens a menu listing the canonical labels as unchecked checkboxes when none are applied", async () => {
      stubFetch();
      renderThread("t1", "arch1");

      const labelsButton = await screen.findByRole("button", { name: i18n.t("mail.labels") });
      fireEvent.click(labelsButton);

      const menu = await screen.findByRole("menu");
      const urgente = within(menu).getByRole("menuitemcheckbox", { name: "urgente" });
      expect(urgente).toHaveAttribute("aria-checked", "false");
      expect(within(menu).getByRole("menuitemcheckbox", { name: "producto" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitemcheckbox", { name: "Diseño" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitemcheckbox", { name: "finanzas" })).toBeInTheDocument();
    });

    it("toggling a canonical label applies the keyword and shows it as a chip next to the subject", async () => {
      const fetchMock = stubFetch();
      renderThread("t1", "arch1");

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      const menu = await screen.findByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "urgente" }));

      const patchCall = await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) =>
            String(input) === "/api/mail/messages/e2" && (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(call).toBeTruthy();
        return call;
      });
      const [, init] = patchCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ keywords: { urgente: true } });

      const heading = await screen.findByRole("heading", { name: "Re: Quarterly report" });
      expect(within(heading.parentElement!).getByText("urgente")).toBeInTheDocument();
    });

    it("unchecking an applied label removes the keyword and its chip", async () => {
      const state = structuredClone(thread);
      state.emails[1]!.keywords = { urgente: true };
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
            return new Response(JSON.stringify({ groupMailInMainInbox: true, customLabels: [] }));
          }
          if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(state));
          return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
        }),
      );
      renderThread("t1", "arch1");

      const heading = await screen.findByRole("heading", { name: "Re: Quarterly report" });
      const chipContainer = heading.parentElement!;
      expect(within(chipContainer).getByText("urgente")).toBeInTheDocument();

      fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.labels") }));
      const menu = await screen.findByRole("menu");
      const urgenteItem = within(menu).getByRole("menuitemcheckbox", { name: "urgente" });
      expect(urgenteItem).toHaveAttribute("aria-checked", "true");
      fireEvent.click(urgenteItem);

      // The menu stays open (Gmail-style multi-select) and still lists
      // "urgente" as an option — only the subject-line chip should disappear.
      await waitFor(() => {
        expect(within(chipContainer).queryByText("urgente")).not.toBeInTheDocument();
      });
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
  });
});
