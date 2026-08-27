import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../app/i18n";
import { MailboxGauge } from "./MailboxGauge";

describe("MailboxGauge", () => {
  it("renders the rounded percentage and an accessible label mentioning the raw counts", () => {
    render(<MailboxGauge linked={18} total={24} />);

    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /18.*24.*75/ })).toBeInTheDocument();
  });

  it("renders 0% without dividing by zero when there are no mailboxes at all", () => {
    render(<MailboxGauge linked={0} total={0} />);

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText("NaN%")).not.toBeInTheDocument();
  });

  it("renders 100% when every mailbox is linked", () => {
    render(<MailboxGauge linked={24} total={24} />);

    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
