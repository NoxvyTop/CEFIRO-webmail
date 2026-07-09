import type { SeedEmail } from "../smtp-seed";

// Three deterministic inbound emails seeded straight into the Stalwart
// fixture's admin@cefiro.test inbox via raw SMTP (see ../smtp-seed.ts).
// Subjects are fixed strings the specs assert on directly, so don't change
// them without updating e2e/tests/mail-connect.spec.ts.
export const SEED_EMAILS: SeedEmail[] = [
  {
    messageId: "seed-1@partner.test",
    from: "Carla Ibarra <carla@partner.test>",
    to: "admin@cefiro.test",
    subject: "Q3 budget draft ready for review",
    body: "Hi,\r\n\r\nAttached (conceptually) is the Q3 budget draft. Let me know if the numbers for the marketing line look right before I send it up the chain.\r\n\r\nThanks,\r\nCarla",
  },
  {
    messageId: "seed-2@partner.test",
    from: "Lucia Fernandez <lucia@partner.test>",
    to: "admin@cefiro.test",
    subject: "Reminder: onboarding call tomorrow at 10am",
    body: "Hey,\r\n\r\nJust a quick reminder that we have the onboarding call scheduled for tomorrow at 10am. I'll send the meeting link shortly.\r\n\r\nSee you then,\r\nLucia",
  },
  {
    messageId: "seed-3@partner.test",
    from: "Marc Duval <marc@partner.test>",
    to: "admin@cefiro.test",
    subject: "Invoice #4821 attached for last month",
    body: "Hello,\r\n\r\nPlease find the invoice for last month's services. Payment terms are net 30 as usual.\r\n\r\nBest regards,\r\nMarc",
  },
];
