import { Hono } from "hono";
import { contactInputSchema } from "@webmail/shared";
import { requireSession } from "../auth/middleware";
import type { ContactsDeps, ContactsVariables } from "./context";

// Autocomplete (GH #124) must stay cheap and must never hand back the whole
// address book on an empty/near-empty query. Both bounds live here rather
// than in the repo, so infra/repos/contacts.ts stays a plain data-access
// layer and every caller of search() is forced through the same limits.
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

export function createContactsRouter(deps: ContactsDeps) {
  const router = new Hono<{ Variables: ContactsVariables }>();

  router.use("*", requireSession(deps.sessions));

  router.get("/contacts", async (c) => {
    const user = c.get("user");
    const list = await deps.contacts.list(user.userId);
    return c.json(list);
  });

  // Below MIN_QUERY_LENGTH this returns [] rather than 400: an autocomplete
  // field firing on every keystroke should not have to special-case an error
  // response for "not enough letters yet" — an empty result list already
  // reads correctly as "nothing to suggest".
  router.get("/contacts/search", async (c) => {
    const user = c.get("user");
    const query = (c.req.query("q") ?? "").trim();
    if (query.length < MIN_QUERY_LENGTH) {
      return c.json([]);
    }
    const results = await deps.contacts.search(user.userId, query, MAX_RESULTS);
    return c.json(results);
  });

  router.post("/contacts", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = contactInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const created = await deps.contacts.create(user.userId, parsed.data);
    if (!created) {
      return c.json(
        { code: "contact_exists", message: "errors.contact_exists", traceId: c.get("traceId") },
        409,
      );
    }
    return c.json(created);
  });

  // GH #163: the user recognises a sender the harvest added on its own and
  // adopts it, which clears the "auto-added" mark both surfaces now show.
  // POST rather than PATCH, with no body: there is exactly one transition this
  // can perform (see ContactsRepo.promote), so there is nothing for a payload
  // to describe and nothing a client could get wrong by omitting it.
  router.post("/contacts/:id/promote", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const promoted = await deps.contacts.promote(user.userId, id);
    if (!promoted) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    return c.json(promoted);
  });

  router.delete("/contacts/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const removed = await deps.contacts.remove(user.userId, id);
    if (!removed) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    return c.json({ ok: true });
  });

  return router;
}

export type ContactsRouter = ReturnType<typeof createContactsRouter>;
