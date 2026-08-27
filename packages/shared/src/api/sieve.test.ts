import { describe, expect, it } from "vitest";
import {
  filterActionSchema,
  filterConditionSchema,
  filterOrderSchema,
  filterRuleInputSchema,
  filterRuleSchema,
  sieveRawScriptInputSchema,
  sieveRawScriptSchema,
  vacationSettingsInputSchema,
  vacationSettingsSchema,
} from "./sieve";

// These schemas are the *input contract* of the Sieve script generator
// (apps/server/src/modules/sieve/generator.ts), which interpolates the values
// that get past them into a script. The generator escapes quotes/backslashes
// and strips control characters as a second line of defence, but the first one
// is here: the single-line constraint below is what keeps a newline out of a
// value that will be emitted inside a quoted Sieve string, and the length caps
// are what keep a rule from being unbounded. GH #229 — packages/shared had no
// coverage gate and these schemas had no tests at all.

const CONDITION = { field: "from", op: "contains", value: "boss@example.com" } as const;

/** `a<control char>b`, built at runtime so no raw control byte sits in this source file. */
const withControlChar = (code: number) => `a${String.fromCharCode(code)}b`;

describe("filterConditionSchema", () => {
  it("accepts every declared field/op pair", () => {
    for (const field of ["from", "to", "subject", "body"] as const) {
      for (const op of ["contains", "is"] as const) {
        expect(filterConditionSchema.parse({ field, op, value: "x" })).toEqual({ field, op, value: "x" });
      }
    }
  });

  it("rejects fields and ops outside the enums", () => {
    expect(() => filterConditionSchema.parse({ ...CONDITION, field: "cc" })).toThrow();
    expect(() => filterConditionSchema.parse({ ...CONDITION, op: "matches" })).toThrow();
  });

  it("rejects an empty value and one over 500 characters", () => {
    expect(() => filterConditionSchema.parse({ ...CONDITION, value: "" })).toThrow();
    expect(filterConditionSchema.parse({ ...CONDITION, value: "a".repeat(500) }).value).toHaveLength(500);
    expect(() => filterConditionSchema.parse({ ...CONDITION, value: "a".repeat(501) })).toThrow();
  });

  it("rejects control characters in the value, so nothing can break out of a Sieve string", () => {
    // A line break is what would terminate the generated `header :contains "…"`
    // line; the rest span the stripped 0x00-0x1f range plus 0x7f DEL.
    const injections = [
      withControlChar(0x0a), // LF
      withControlChar(0x0d), // CR
      withControlChar(0x00), // NUL
      withControlChar(0x09), // TAB
      withControlChar(0x1b), // ESC
      withControlChar(0x7f), // DEL
    ];
    for (const value of injections) {
      expect(() => filterConditionSchema.parse({ ...CONDITION, value })).toThrow();
    }
  });

  it("keeps quotes and backslashes parseable — escaping them is the generator's job, not a rejection here", () => {
    const value = 'a" fileinto "Trash"; # \\';
    expect(filterConditionSchema.parse({ ...CONDITION, value }).value).toBe(value);
  });
});

describe("filterActionSchema", () => {
  it("accepts each member of the discriminated union", () => {
    expect(filterActionSchema.parse({ type: "fileinto", folder: "Work" })).toEqual({
      type: "fileinto",
      folder: "Work",
    });
    expect(filterActionSchema.parse({ type: "seen" })).toEqual({ type: "seen" });
    expect(filterActionSchema.parse({ type: "flag", keyword: "$important" })).toEqual({
      type: "flag",
      keyword: "$important",
    });
    expect(filterActionSchema.parse({ type: "delete" })).toEqual({ type: "delete" });
    expect(filterActionSchema.parse({ type: "stop" })).toEqual({ type: "stop" });
  });

  it("rejects an unknown discriminator", () => {
    expect(() => filterActionSchema.parse({ type: "forward", to: "x@y.z" })).toThrow();
  });

  it("requires a non-empty, single-line folder no longer than 200 characters", () => {
    expect(() => filterActionSchema.parse({ type: "fileinto", folder: "" })).toThrow();
    expect(() => filterActionSchema.parse({ type: "fileinto", folder: "a".repeat(201) })).toThrow();
    expect(() =>
      filterActionSchema.parse({ type: "fileinto", folder: withControlChar(0x0a) }),
    ).toThrow();
  });

  it("restricts flag keywords to the IMAP keyword character set", () => {
    for (const keyword of ["Seen", "$label1", "a_b.c-d"]) {
      expect(filterActionSchema.parse({ type: "flag", keyword })).toEqual({ type: "flag", keyword });
    }
    const rejected = ["", "has space", 'quote"', "back\\slash", withControlChar(0x0a), "a".repeat(65)];
    for (const keyword of rejected) {
      expect(() => filterActionSchema.parse({ type: "flag", keyword })).toThrow();
    }
  });
});

describe("filterRuleInputSchema", () => {
  const input = {
    name: "Boss to Work",
    matchType: "all",
    conditions: [CONDITION],
    actions: [{ type: "fileinto", folder: "Work" }],
  };

  it("defaults enabled to true", () => {
    expect(filterRuleInputSchema.parse(input).enabled).toBe(true);
    expect(filterRuleInputSchema.parse({ ...input, enabled: false }).enabled).toBe(false);
  });

  it("requires a non-empty, single-line name of at most 100 characters", () => {
    expect(() => filterRuleInputSchema.parse({ ...input, name: "" })).toThrow();
    expect(() => filterRuleInputSchema.parse({ ...input, name: "a".repeat(101) })).toThrow();
    expect(() => filterRuleInputSchema.parse({ ...input, name: withControlChar(0x0a) })).toThrow();
  });

  it("bounds conditions and actions to 1..10 each", () => {
    expect(() => filterRuleInputSchema.parse({ ...input, conditions: [] })).toThrow();
    expect(() => filterRuleInputSchema.parse({ ...input, actions: [] })).toThrow();
    expect(filterRuleInputSchema.parse({ ...input, conditions: Array(10).fill(CONDITION) }).conditions).toHaveLength(
      10,
    );
    expect(() => filterRuleInputSchema.parse({ ...input, conditions: Array(11).fill(CONDITION) })).toThrow();
    expect(() => filterRuleInputSchema.parse({ ...input, actions: Array(11).fill({ type: "stop" }) })).toThrow();
  });

  it("accepts both match types and rejects anything else", () => {
    expect(filterRuleInputSchema.parse({ ...input, matchType: "any" }).matchType).toBe("any");
    expect(() => filterRuleInputSchema.parse({ ...input, matchType: "none" })).toThrow();
  });
});

describe("filterRuleSchema", () => {
  it("parses a stored rule, including its id, position and enabled flag", () => {
    const rule = {
      id: "rule-1",
      position: 3,
      name: "Boss",
      matchType: "any",
      conditions: [CONDITION],
      actions: [{ type: "seen" }],
      enabled: false,
    };
    expect(filterRuleSchema.parse(rule)).toEqual(rule);
  });

  it("requires an integer position", () => {
    const rule = {
      id: "rule-1",
      position: 1.5,
      name: "Boss",
      matchType: "all",
      conditions: [CONDITION],
      actions: [{ type: "seen" }],
      enabled: true,
    };
    expect(() => filterRuleSchema.parse(rule)).toThrow();
  });
});

describe("filterOrderSchema", () => {
  it("requires at least one id and caps the list at 200", () => {
    expect(filterOrderSchema.parse({ ids: ["a"] }).ids).toEqual(["a"]);
    expect(() => filterOrderSchema.parse({ ids: [] })).toThrow();
    expect(filterOrderSchema.parse({ ids: Array(200).fill("a") }).ids).toHaveLength(200);
    expect(() => filterOrderSchema.parse({ ids: Array(201).fill("a") })).toThrow();
  });
});

describe("vacationSettingsSchema", () => {
  it("parses stored settings with null dates", () => {
    const settings = {
      enabled: true,
      subject: "Out of office",
      message: "Back on Monday",
      startsAt: null,
      endsAt: null,
      intervalDays: 7,
    };
    expect(vacationSettingsSchema.parse(settings)).toEqual(settings);
  });

  it("requires an integer intervalDays", () => {
    expect(() =>
      vacationSettingsSchema.parse({
        enabled: false,
        subject: "",
        message: "",
        startsAt: null,
        endsAt: null,
        intervalDays: 2.5,
      }),
    ).toThrow();
  });
});

describe("vacationSettingsInputSchema", () => {
  it("fills every optional field with its default", () => {
    expect(vacationSettingsInputSchema.parse({ enabled: false })).toEqual({
      enabled: false,
      subject: "",
      message: "",
      startsAt: null,
      endsAt: null,
      intervalDays: 7,
    });
  });

  it("requires a non-blank message only when enabled", () => {
    expect(() => vacationSettingsInputSchema.parse({ enabled: true, message: "   " })).toThrow(
      /message required when enabled/,
    );
    expect(vacationSettingsInputSchema.parse({ enabled: true, message: "Away" }).message).toBe("Away");
    expect(vacationSettingsInputSchema.parse({ enabled: false, message: "" }).enabled).toBe(false);
  });

  it("rejects an end date before the start date, and allows either being open-ended", () => {
    const base = { enabled: false } as const;
    expect(() =>
      vacationSettingsInputSchema.parse({ ...base, startsAt: "2026-01-10", endsAt: "2026-01-01" }),
    ).toThrow(/endsAt must not be before startsAt/);
    expect(
      vacationSettingsInputSchema.parse({ ...base, startsAt: "2026-01-01", endsAt: "2026-01-01" }).endsAt,
    ).toBe("2026-01-01");
    expect(vacationSettingsInputSchema.parse({ ...base, startsAt: "2026-01-10", endsAt: null }).endsAt).toBeNull();
    expect(vacationSettingsInputSchema.parse({ ...base, startsAt: null, endsAt: "2026-01-01" }).startsAt).toBeNull();
  });

  it("requires ISO yyyy-mm-dd dates", () => {
    expect(() => vacationSettingsInputSchema.parse({ enabled: false, startsAt: "10/01/2026" })).toThrow();
    expect(() => vacationSettingsInputSchema.parse({ enabled: false, startsAt: "2026-1-1" })).toThrow();
  });

  it("keeps the subject single-line and bounded, and the message under 5000 characters", () => {
    expect(() =>
      vacationSettingsInputSchema.parse({ enabled: false, subject: withControlChar(0x0a) }),
    ).toThrow();
    expect(() => vacationSettingsInputSchema.parse({ enabled: false, subject: "a".repeat(201) })).toThrow();
    expect(() => vacationSettingsInputSchema.parse({ enabled: true, message: "a".repeat(5001) })).toThrow();
  });

  it("bounds intervalDays to 1..60", () => {
    expect(() => vacationSettingsInputSchema.parse({ enabled: false, intervalDays: 0 })).toThrow();
    expect(() => vacationSettingsInputSchema.parse({ enabled: false, intervalDays: 61 })).toThrow();
    expect(vacationSettingsInputSchema.parse({ enabled: false, intervalDays: 60 }).intervalDays).toBe(60);
  });
});

// GH #23: the advanced mode. This input is the ONE place a user's own Sieve
// enters the system, and its contract is narrow on purpose — reject what cannot
// be stored or cannot be meant, and rewrite nothing. Whether the script is
// valid Sieve is the mail server's answer to give, through SieveScript/validate.
describe("sieveRawScriptInputSchema", () => {
  it("accepts a hand-written script unchanged, newlines and all", () => {
    const script = 'require ["fileinto"];\r\nif header :contains "to" "ops" {\n  fileinto "Ops";\n}\n';
    expect(sieveRawScriptInputSchema.parse({ script }).script).toBe(script);
  });

  it("rejects a blank script rather than reading it as 'filter nothing'", () => {
    // Handing the script back to the rule builder is how a user stops using
    // theirs. Accepting an emptied textarea here would make an accident the one
    // way a saved script gets discarded.
    expect(() => sieveRawScriptInputSchema.parse({ script: "" })).toThrow();
    expect(() => sieveRawScriptInputSchema.parse({ script: "  \n\t " })).toThrow();
  });

  it("rejects a NUL byte, which a Postgres text column cannot hold", () => {
    expect(() => sieveRawScriptInputSchema.parse({ script: "stop;\u0000" })).toThrow();
  });

  it("bounds the script", () => {
    expect(() => sieveRawScriptInputSchema.parse({ script: "a".repeat(65_537) })).toThrow();
    expect(sieveRawScriptInputSchema.parse({ script: "a".repeat(65_536) }).script).toHaveLength(
      65_536,
    );
  });
});

describe("sieveRawScriptSchema", () => {
  it("carries the mode, the stored script and when it was written", () => {
    expect(
      sieveRawScriptSchema.parse({
        mode: "raw",
        script: "stop;",
        updatedAt: "2026-07-01T10:00:00.000Z",
      }),
    ).toEqual({ mode: "raw", script: "stop;", updatedAt: "2026-07-01T10:00:00.000Z" });
    // A user who never opened the editor: rule-builder mode, nothing stored.
    expect(
      sieveRawScriptSchema.parse({ mode: "rules", script: "", updatedAt: null }).updatedAt,
    ).toBeNull();
  });

  it("admits no third author", () => {
    expect(() =>
      sieveRawScriptSchema.parse({ mode: "merged", script: "", updatedAt: null }),
    ).toThrow();
  });
});
