import type { FilterRule, FilterRuleInput } from "@webmail/shared";
import type { Db } from "../db/client";

type FilterRuleRow = {
  id: string;
  position: number;
  name: string;
  match_type: string;
  conditions: string | FilterRule["conditions"];
  actions: string | FilterRule["actions"];
  enabled: boolean;
};

function toFilterRule(row: FilterRuleRow): FilterRule {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    matchType: row.match_type as FilterRule["matchType"],
    conditions: typeof row.conditions === "string" ? JSON.parse(row.conditions) : row.conditions,
    actions: typeof row.actions === "string" ? JSON.parse(row.actions) : row.actions,
    enabled: row.enabled,
  };
}

export function createFilterRulesRepo(sql: Db) {
  return {
    async list(userId: string): Promise<FilterRule[]> {
      const rows = await sql<FilterRuleRow[]>`
        select id, position, name, match_type, conditions, actions, enabled
        from filter_rules
        where user_id = ${userId}
        order by position asc, created_at asc
      `;
      return rows.map(toFilterRule);
    },

    async create(userId: string, input: FilterRuleInput): Promise<FilterRule> {
      return sql.begin(async (tx) => {
        const positions = await tx<{ next: number }[]>`
          select coalesce(max(position), -1) + 1 as next
          from filter_rules where user_id = ${userId}
        `;
        const rows = await tx<FilterRuleRow[]>`
          insert into filter_rules (user_id, position, name, match_type, conditions, actions, enabled)
          values (
            ${userId}, ${positions[0]!.next}, ${input.name}, ${input.matchType},
            ${JSON.stringify(input.conditions)}::jsonb,
            ${JSON.stringify(input.actions)}::jsonb,
            ${input.enabled}
          )
          returning id, position, name, match_type, conditions, actions, enabled
        `;
        return toFilterRule(rows[0]!);
      });
    },

    async update(
      userId: string,
      id: string,
      input: FilterRuleInput,
    ): Promise<FilterRule | null> {
      const rows = await sql<FilterRuleRow[]>`
        update filter_rules
        set name = ${input.name},
            match_type = ${input.matchType},
            conditions = ${JSON.stringify(input.conditions)}::jsonb,
            actions = ${JSON.stringify(input.actions)}::jsonb,
            enabled = ${input.enabled}
        where id = ${id} and user_id = ${userId}
        returning id, position, name, match_type, conditions, actions, enabled
      `;
      return rows[0] ? toFilterRule(rows[0]) : null;
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const rows = await sql`
        delete from filter_rules where id = ${id} and user_id = ${userId} returning id
      `;
      return rows.length > 0;
    },

    async reorder(userId: string, ids: string[]): Promise<boolean> {
      return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id from filter_rules where user_id = ${userId}
        `;
        const owned = new Set(rows.map((row) => row.id));
        const unique = new Set(ids);
        if (
          ids.length !== owned.size ||
          unique.size !== ids.length ||
          !ids.every((id) => owned.has(id))
        ) {
          return false;
        }
        for (const [index, id] of ids.entries()) {
          await tx`
            update filter_rules set position = ${index}
            where id = ${id} and user_id = ${userId}
          `;
        }
        return true;
      });
    },
  };
}

export type FilterRulesRepo = ReturnType<typeof createFilterRulesRepo>;
