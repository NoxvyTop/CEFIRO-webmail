/**
 * The account's Email state carried by one JMAP EventSource frame, or undefined
 * when the frame is not an Email StateChange for this account.
 *
 * A JMAP StateChange event looks like:
 *   event: state
 *   data: {"@type":"StateChange","changed":{"<accountId>":{"Email":"<state>",...}}}
 *
 * Only the `Email` slot matters for harvesting; Mailbox/Thread changes (a read
 * flag flipping, a move) are not new mail. Anything unparseable is ignored — a
 * keepalive comment, a partial frame, or a shape we do not recognise must never
 * throw on the hot streaming path.
 */
export function emailStateFromFrame(frame: string, accountId: string): string | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data === "") return undefined;
  try {
    const parsed = JSON.parse(data) as {
      changed?: Record<string, Record<string, string> | undefined>;
    };
    const state = parsed.changed?.[accountId]?.Email;
    return typeof state === "string" ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps a JMAP EventSource byte stream so it flows through to the client
 * unchanged while invoking onEmailStateChange() once per *change* to the
 * account's Email state (GH #180) — i.e. once when mail arrives, in place of the
 * per-read harvest GET /messages used to do.
 *
 * The first Email state observed after connecting is the baseline and does not
 * fire: reconnecting to an unchanged mailbox must not re-harvest; only mail that
 * arrives while the connection is open should. Repeated identical states are
 * likewise ignored (a Mailbox-only change re-sends the unchanged Email state).
 *
 * Bytes are always enqueued first and never modified, so the proxied stream is
 * byte-for-byte identical. The callback's promise is tracked and awaited in
 * flush() so the side effect settles when the stream ends (and so tests are
 * deterministic); its rejections are swallowed — harvesting is best-effort and
 * must never break the stream.
 */
/**
 * The state transition one callback invocation describes: the account's Email
 * state before this frame and after it.
 *
 * `previousState` is what makes an incremental read possible (GH #337): it is
 * exactly the `sinceState` an `Email/changes` call needs to learn WHICH
 * messages appeared, instead of re-listing the mailbox to guess. Both are
 * always defined at the call site — the baseline frame does not fire.
 */
export type EmailStateChange = { state: string; previousState: string };

export function tapEmailStateChanges(input: {
  source: ReadableStream<Uint8Array<ArrayBufferLike>>;
  accountId: string;
  onEmailStateChange: (change: EmailStateChange) => Promise<void> | void;
}): ReadableStream<Uint8Array<ArrayBufferLike>> {
  const decoder = new TextDecoder();
  const pending = new Set<Promise<void>>();
  let buffer = "";
  let lastEmailState: string | undefined;
  let baselineSet = false;

  const fire = (change: EmailStateChange) => {
    const promise = Promise.resolve()
      .then(() => input.onEmailStateChange(change))
      .catch(() => {});
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const consumeFrame = (frame: string) => {
    const state = emailStateFromFrame(frame, input.accountId);
    if (state === undefined) return;
    if (!baselineSet) {
      lastEmailState = state;
      baselineSet = true;
      return;
    }
    if (state === lastEmailState) return;
    const previousState = lastEmailState as string;
    lastEmailState = state;
    fire({ state, previousState });
  };

  const transform = new TransformStream<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        consumeFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  });

  return input.source.pipeThrough(transform);
}
