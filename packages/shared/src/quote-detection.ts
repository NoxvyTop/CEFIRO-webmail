// GH #168: reply-separator lines a mail client inserts directly above a
// quoted trail — Gmail's Spanish/English "El ... escribió:" / "On ... wrote:"
// line, Outlook's "-----Original Message-----" banner (with variable
// internal whitespace), and Outlook's underscore divider above the quoted
// headers. This used to be reimplemented independently by the server (for
// AI-summary quote stripping) and the web client (for the reader's
// plain-text quote split), and the two copies had already drifted apart —
// the client's Gmail pattern was missing the `i` flag, and its Outlook
// pattern required exactly one literal space where the server accepted any
// run of whitespace. Both consumers now import this single definition, so a
// case/whitespace variant either both sides split on, or neither does.
const QUOTE_SEPARATOR_PATTERNS: RegExp[] = [
  /^el .+ escribió:\s*$/i, // Gmail (es): "El <date>, <name> <email> escribió:"
  /^on .+ wrote:\s*$/i, // Gmail (en): "On <date>, <name> <email> wrote:"
  /^-{3,}\s*original\s+message\s*-{3,}$/i, // Outlook: "-----Original Message-----"
  /^_{8,}$/, // Outlook's underscore divider above the quoted headers
];

export function isQuoteSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  return QUOTE_SEPARATOR_PATTERNS.some((pattern) => pattern.test(trimmed));
}
