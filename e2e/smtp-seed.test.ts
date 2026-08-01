import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { readResponse, withConversationRetry } from "./smtp-seed";

// Regression cover for GH #184. A Stalwart that is still finishing startup
// accepts the TCP/TLS socket and then closes it *mid-conversation* — before it
// ever answers EHLO or the DATA terminator. connectWithRetry only guards the
// handshake, so that drop is invisible to it; readResponse instead surfaces it
// as "SMTP connection closed before a final response arrived". withConversationRetry
// wraps the whole per-message conversation so this premature close is retried
// with the existing bounded budget/backoff, rather than failing the seed on the
// first drop. These tests pin that behavior using the real readResponse close
// path (fed by a bare EventEmitter standing in for the socket), so they exercise
// the exact error the seeder throws in CI, not a hand-rolled stand-in.

// readResponse only ever uses the socket's EventEmitter surface (on/off for
// "data"/"error"/"close"), so a bare EventEmitter is a faithful stand-in — but
// its declared parameter is the full net.Socket, hence the widening cast. Kept
// in one helper so the cast is stated once, with this reason.
function asSocket(emitter: EventEmitter): Socket {
  return emitter as unknown as Socket;
}

// Produces the exact premature-close rejection (empty buffer) via the real
// readResponse "close" handler.
function prematureClose(): Promise<unknown> {
  const socket = new EventEmitter();
  const pending = readResponse(asSocket(socket));
  socket.emit("close");
  return pending;
}

test("readResponse resolves on a final SMTP reply line", async () => {
  const socket = new EventEmitter();
  const pending = readResponse(asSocket(socket));
  socket.emit("data", Buffer.from("250 OK\r\n"));
  const response = await pending;
  expect(response.code).toBe(250);
});

test("readResponse rejects when the socket closes before any reply", async () => {
  await expect(prematureClose()).rejects.toThrow(
    /SMTP connection closed before a final response arrived/,
  );
});

test("withConversationRetry retries a mid-conversation premature close, then succeeds", async () => {
  let attempts = 0;
  const result = await withConversationRetry("seedJunk retry", async () => {
    attempts += 1;
    if (attempts === 1) {
      // First attempt drops mid-conversation — must be retried, not fatal.
      await prematureClose();
    }
    return "delivered";
  });
  expect(result).toBe("delivered");
  expect(attempts).toBe(2);
});

test("withConversationRetry stays bounded and surfaces the close error after exhausting retries", async () => {
  let attempts = 0;
  const run = withConversationRetry("seedJunk exhausted", async () => {
    attempts += 1;
    // Never recovers: every attempt drops mid-conversation.
    await prematureClose();
    return "unreachable";
  });
  await expect(run).rejects.toThrow(
    /failed after 5 attempts: SMTP connection closed before a final response arrived/,
  );
  // CONNECT_RETRIES === 5: the retry is bounded, never an infinite loop.
  expect(attempts).toBe(5);
}, 15_000);
