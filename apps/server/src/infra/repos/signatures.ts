import type { Signature, SignatureInput } from "@webmail/shared";
import type { Db } from "../db/client";

type SignatureRow = {
  id: string;
  name: string;
  content_html: string;
  is_default: boolean;
};

function toSignature(row: SignatureRow): Signature {
  return {
    id: row.id,
    name: row.name,
    contentHtml: row.content_html,
    isDefault: row.is_default,
  };
}

export function createSignaturesRepo(sql: Db) {
  return {
    async list(userId: string): Promise<Signature[]> {
      const rows = await sql<SignatureRow[]>`
        select id, name, content_html, is_default
        from signatures
        where user_id = ${userId}
        order by is_default desc, name asc
      `;
      return rows.map(toSignature);
    },

    async create(userId: string, input: SignatureInput): Promise<Signature> {
      return sql.begin(async (tx) => {
        if (input.isDefault) {
          await tx`update signatures set is_default = false where user_id = ${userId}`;
        }
        const rows = await tx<SignatureRow[]>`
          insert into signatures (user_id, name, content_html, is_default)
          values (${userId}, ${input.name}, ${input.contentHtml}, ${input.isDefault})
          returning id, name, content_html, is_default
        `;
        return toSignature(rows[0]!);
      });
    },

    async update(userId: string, id: string, input: SignatureInput): Promise<Signature | null> {
      return sql.begin(async (tx) => {
        const rows = await tx<SignatureRow[]>`
          update signatures
          set name = ${input.name}, content_html = ${input.contentHtml}, is_default = ${input.isDefault}
          where id = ${id} and user_id = ${userId}
          returning id, name, content_html, is_default
        `;
        if (!rows[0]) {
          return null;
        }
        if (input.isDefault) {
          await tx`
            update signatures set is_default = false where user_id = ${userId} and id != ${id}
          `;
        }
        return toSignature(rows[0]);
      });
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const rows = await sql`
        delete from signatures where id = ${id} and user_id = ${userId} returning id
      `;
      return rows.length > 0;
    },
  };
}

export type SignaturesRepo = ReturnType<typeof createSignaturesRepo>;
