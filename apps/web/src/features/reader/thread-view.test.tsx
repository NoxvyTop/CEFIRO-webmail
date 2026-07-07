import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
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

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(thread));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    }),
  );
}

function renderThread(threadId = "t1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ThreadView threadId={threadId} />
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
});
