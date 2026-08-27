import type { Contact, ContactInput } from "@webmail/shared";
import type { Db } from "../db/client";

type ContactRow = {
  id: string;
  name: string;
  email: string;
  source: "manual" | "harvested";
};

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    source: row.source,
  };
}

// Sender extracted from a fetched message, ready for the harvest bulk upsert.
// Intentionally the same shape as ContactInput's essentials (name/email) but
// kept separate because the caller (contacts-harvest.ts) never runs it
// through contactInputSchema — the address comes from JMAP, not user input.
export type HarvestedContact = { name: string; email: string };

export function createContactsRepo(sql: Db) {
  return {
    async list(userId: string): Promise<Contact[]> {
      const rows = await sql<ContactRow[]>`
        select id, name, email, source
        from contacts
        where user_id = ${userId}
        order by name asc, email asc
      `;
      return rows.map(toContact);
    },

    // Prefix match against BOTH name and email (GH #124: autocomplete must
    // find a contact by either). Case-insensitive via ILIKE regardless of
    // how the name was originally cased — email is already stored lowercased
    // (see create() below) but ILIKE is used for it too rather than relying
    // on that invariant. Bounding the query length/result count is the
    // caller's job (modules/contacts/router.ts), not this repo's — `limit`
    // is taken as given so there is exactly one place that decides the cap.
    async search(userId: string, query: string, limit: number): Promise<Contact[]> {
      const pattern = `${query}%`;
      const rows = await sql<ContactRow[]>`
        select id, name, email, source
        from contacts
        where user_id = ${userId}
          and (email ilike ${pattern} or name ilike ${pattern})
        order by name asc, email asc
        limit ${limit}
      `;
      return rows.map(toContact);
    },

    // Returns null on a duplicate (case-insensitive) address for this user —
    // the route turns that into 409 contact_exists — rather than throwing,
    // since a duplicate is an expected, not exceptional, outcome here.
    //
    // A manual add is a deliberate signal that the user wants this exact
    // address in their book, so it also clears any earlier deletion
    // tombstone (see remove() below and 0006_contacts.sql) — otherwise
    // re-adding an address by hand right after deleting it would silently do
    // nothing to future harvests of that same sender.
    async create(userId: string, input: ContactInput): Promise<Contact | null> {
      const email = input.email.trim().toLowerCase();
      const name = input.name?.trim() ?? "";
      return sql.begin(async (tx) => {
        await tx`
          delete from contact_suppressions where user_id = ${userId} and email = ${email}
        `;
        const rows = await tx<ContactRow[]>`
          insert into contacts (user_id, name, email, source)
          values (${userId}, ${name}, ${email}, 'manual')
          on conflict (user_id, email) do nothing
          returning id, name, email, source
        `;
        return rows[0] ? toContact(rows[0]) : null;
      });
    },

    // GH #163: adopts a harvested contact as one of the user's own. Now that
    // both surfaces mark provenance, recognising a sender needs a way to act
    // on it — this is the constructive counterpart to remove() below, for the
    // sender you *do* know rather than the one you don't.
    //
    // Only ever 'harvested' -> 'manual'. There is deliberately no downgrade:
    // nothing the user does by hand should be able to make an address look
    // less vouched-for than it already is, and harvestSenders() above already
    // refuses to touch a row that exists.
    //
    // Idempotent on an already-manual contact — it returns the row unchanged
    // rather than reporting a miss, since "make this mine" is satisfied by a
    // contact that is already mine and the caller shouldn't special-case it.
    // Null means no such contact *for this user*, which is what makes the
    // route's 404 an ownership check as well as an existence one.
    async promote(userId: string, id: string): Promise<Contact | null> {
      const rows = await sql<ContactRow[]>`
        update contacts
        set source = 'manual'
        where id = ${id} and user_id = ${userId}
        returning id, name, email, source
      `;
      return rows[0] ? toContact(rows[0]) : null;
    },

    // Deletes the contact and records a tombstone for its address so the
    // harvest bulk upsert (harvestSenders below) never silently re-adds it —
    // GH #124's "never resurrect a deleted contact". Recorded regardless of
    // whether the contact was manual or harvested: once the user has
    // explicitly removed an address, harvesting it straight back in on the
    // next mail fetch would be surprising either way.
    async remove(userId: string, id: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const rows = await tx<{ email: string }[]>`
          delete from contacts where id = ${id} and user_id = ${userId} returning email
        `;
        const deleted = rows[0];
        if (!deleted) return false;
        await tx`
          insert into contact_suppressions (user_id, email)
          values (${userId}, ${deleted.email})
          on conflict (user_id, email) do nothing
        `;
        return true;
      });
    },

    // Bulk upsert for the mail-listing harvest (modules/mail/contacts-harvest.ts,
    // GH #124): one statement for the whole batch of senders seen on a fetched
    // page, not a write per message. Suppressed addresses (see remove() above)
    // and addresses that already have a contact — of either source, so a
    // harvested guess never clobbers a name the user typed in by hand — are
    // excluded by the query itself via NOT EXISTS / ON CONFLICT DO NOTHING,
    // so the caller does not need a separate read before writing.
    async harvestSenders(userId: string, entries: HarvestedContact[]): Promise<void> {
      if (entries.length === 0) return;
      const rows = entries.map((e) => [userId, e.name?.trim() ?? "", e.email.trim().toLowerCase()]);
      await sql`
        insert into contacts (user_id, name, email, source)
        select v.user_id::uuid, v.name, v.email, 'harvested'
        from (values ${sql(rows)}) as v(user_id, name, email)
        where not exists (
          select 1 from contact_suppressions s
          where s.user_id = v.user_id::uuid and s.email = v.email
        )
        on conflict (user_id, email) do nothing
      `;
    },
  };
}

export type ContactsRepo = ReturnType<typeof createContactsRepo>;
