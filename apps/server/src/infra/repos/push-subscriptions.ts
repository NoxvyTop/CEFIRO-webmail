import type { Db } from "../db/client";

// #294 (delivery slice): the store of Web Push subscriptions, one row per
// device a user has opted in from. The subscription keys (p256dh/auth) are the
// device's own public key material, not secrets of ours, so — unlike
// mail-credentials.ts — this repo takes no keyring and stores them as-is.

/**
 * A stored subscription in the shape the `web-push` adapter needs to encrypt a
 * payload for one device. Deliberately NOT the browser's nested
 * `{ endpoint, keys: { p256dh, auth } }` shape: the adapter re-nests it, and a
 * flat row is what the query returns.
 */
export type StoredPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export function createPushSubscriptionsRepo(sql: Db) {
  return {
    /**
     * Create-or-update by endpoint. A browser re-subscribing produces the same
     * endpoint, so the second opt-in must refresh that row's keys, owner and
     * `last_seen_at` in place rather than insert a duplicate (the unique
     * constraint on `endpoint` would reject the insert otherwise). The owner is
     * overwritten too: a shared device handed from one user to the next
     * re-points the endpoint at whoever subscribed last, so the previous user
     * can no longer be pushed through a device that is not theirs.
     */
    async upsert(input: {
      userId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      userAgent?: string | null;
    }): Promise<void> {
      await sql`
        insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        values (${input.userId}, ${input.endpoint}, ${input.p256dh}, ${input.auth}, ${input.userAgent ?? null})
        on conflict (endpoint) do update set
          user_id = excluded.user_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          last_seen_at = now()
      `;
    },

    /** Every subscription for one user — the fan-out target of a delivery. */
    async listByUser(userId: string): Promise<StoredPushSubscription[]> {
      const rows = await sql<StoredPushSubscription[]>`
        select endpoint, p256dh, auth
        from push_subscriptions
        where user_id = ${userId}
        order by last_seen_at desc
      `;
      return rows.map((row) => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
    },

    /**
     * Remove a dead endpoint regardless of owner. Called when the push service
     * answers `410 Gone`/`404` (the subscription has expired) — at that point
     * the endpoint is useless to anyone, so it is dropped without a user scope.
     */
    async deleteByEndpoint(endpoint: string): Promise<void> {
      await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
    },

    /**
     * Remove an endpoint the session user is opting out of. Scoped to the user
     * so a caller cannot delete someone else's subscription by naming its
     * endpoint — the opt-out path, distinct from the expiry path above.
     */
    async deleteByUserAndEndpoint(userId: string, endpoint: string): Promise<void> {
      await sql`
        delete from push_subscriptions
        where user_id = ${userId} and endpoint = ${endpoint}
      `;
    },
  };
}

export type PushSubscriptionsRepo = ReturnType<typeof createPushSubscriptionsRepo>;
