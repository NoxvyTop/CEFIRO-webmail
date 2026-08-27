import { describe, expect, it } from "vitest";
import {
  clientIp,
  DEFAULT_TRUSTED_PROXY_HOPS,
  rateLimitKey,
  UNATTRIBUTED_CLIENT,
} from "./client-ip";

// GH #238. The whole security property lives in one arithmetic decision — which
// end of X-Forwarded-For is counted from — so it is worth pinning from both
// sides: what a correct proxy chain yields, and what an attacker gets for every
// way of lying about it.

function request(forwardedFor?: string) {
  return {
    req: {
      header: (name: string) =>
        name === "x-forwarded-for" ? forwardedFor : undefined,
    },
  };
}

describe("client IP attribution (GH #238)", () => {
  it("takes the entry the trusted proxy appended, not the one the client sent", () => {
    // nginx with $proxy_add_x_forwarded_for appends the address it saw, so with
    // one trusted hop the real client is the LAST entry. Everything to its left
    // is whatever the caller decided to type.
    expect(clientIp(request("9.9.9.9, 8.8.8.8, 203.0.113.7"), 1)).toBe("203.0.113.7");
  });

  it("counts hops from the right, so a longer chain of proxies still resolves", () => {
    // CDN → nginx → app: the CDN appended the client, nginx appended the CDN.
    const chain = "9.9.9.9, 203.0.113.7, 172.16.0.1";
    expect(clientIp(request(chain), 2)).toBe("203.0.113.7");
    expect(clientIp(request(chain), 1)).toBe("172.16.0.1");
  });

  it("gives an attacker the same key however many hops they prepend", () => {
    const keys = [
      "203.0.113.7",
      "1.2.3.4, 203.0.113.7",
      "1.2.3.4, 5.6.7.8, 203.0.113.7",
      "  , , 203.0.113.7",
    ].map((forwardedFor) => rateLimitKey(request(forwardedFor), 1));

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("203.0.113.7");
  });

  it("trims the whitespace proxies conventionally put after the comma", () => {
    expect(clientIp(request("1.2.3.4,   203.0.113.7  "), 1)).toBe("203.0.113.7");
  });

  it("attributes nothing when the header is absent or empty", () => {
    // The container's own probe connects directly and sends no header.
    expect(clientIp(request(), 1)).toBeUndefined();
    expect(clientIp(request(""), 1)).toBeUndefined();
    expect(clientIp(request("   "), 1)).toBeUndefined();
  });

  it("attributes nothing when the chain is shorter than the declared hop count", () => {
    // A request that reached this process without passing every trusted proxy
    // did not travel the path the operator described. Falling back to the
    // shared bucket is the direction this failure has to lean: stripping the
    // header must never be a way to pick your own key.
    expect(clientIp(request("203.0.113.7"), 2)).toBeUndefined();
    expect(clientIp(request("1.2.3.4, 203.0.113.7"), 3)).toBeUndefined();
  });

  it("ignores the header entirely when no proxy is trusted", () => {
    // TRUSTED_PROXY_HOPS=0 is "this process is exposed directly", where every
    // entry is caller-written and none of them mean anything.
    expect(clientIp(request("203.0.113.7"), 0)).toBeUndefined();
    expect(rateLimitKey(request("203.0.113.7"), 0)).toBe(UNATTRIBUTED_CLIENT);
  });

  it("refuses a value longer than the longest possible address", () => {
    // Only reachable in a misconfigured deployment (fewer real hops than
    // declared), and precisely there nothing arbitrary-length may become a
    // rate-limiter key or an audit row.
    const longestIpv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334%eth0000000";
    expect(longestIpv6.length).toBeGreaterThan(45);
    expect(clientIp(request(longestIpv6), 1)).toBeUndefined();
    expect(clientIp(request("2001:db8::8a2e:370:7334"), 1)).toBe("2001:db8::8a2e:370:7334");
  });

  it("sends every unattributable request to ONE shared bucket", () => {
    // Not a key each: minting a bucket from a value we just declared
    // unbelievable is the defect this module exists to close.
    expect(rateLimitKey(request(), 1)).toBe(UNATTRIBUTED_CLIENT);
    expect(rateLimitKey(request(""), 1)).toBe(UNATTRIBUTED_CLIENT);
    expect(rateLimitKey(request("1.2.3.4"), 5)).toBe(UNATTRIBUTED_CLIENT);
  });

  it("defaults to the single appending proxy this repository documents", () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
    expect(clientIp(request("1.2.3.4, 203.0.113.7"), DEFAULT_TRUSTED_PROXY_HOPS)).toBe(
      "203.0.113.7",
    );
  });
});
