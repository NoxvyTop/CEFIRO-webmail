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

// Long, table-laid-out HTML promotional newsletter — the workhorse spam
// fixture. Deliberately built the way real marketing mail is: nested
// presentation tables, inline styles, and remote image references. Long
// enough on its own to exercise reading-pane truncation (GH #135). Every
// brand, domain, address, and price below is fabricated for this fixture —
// "Solandra Outlet" is not a real company and solandra-outlet.test is a
// reserved, non-resolving test domain (RFC 2606).
const SOLANDRA_PRODUCTS = [
  { name: "Cascade Weekender Bag", was: "$128.00", now: "$38.40", blurb: "Water-resistant canvas, fits a 15\" laptop, now 70% off for the Summer Mega Sale." },
  { name: "Halcyon Linen Shirt", was: "$64.00", now: "$22.40", blurb: "Breathable linen blend in five colorways, marked down 65% through Sunday." },
  { name: "Driftline Sunglasses", was: "$45.00", now: "$18.00", blurb: "Polarized UV400 lenses, 60% off while stock lasts." },
  { name: "Basecamp Steel Bottle", was: "$32.00", now: "$12.80", blurb: "24-hour cold retention, 60% off this week only." },
  { name: "Meridian Trail Runners", was: "$110.00", now: "$33.00", blurb: "Lightweight trail mesh, 70% off, limited sizes remaining." },
  { name: "Solstice Beach Towel", was: "$28.00", now: "$9.80", blurb: "Quick-dry microfiber, 65% off, six patterns available." },
  { name: "Wanderlight Daypack", was: "$56.00", now: "$19.60", blurb: "Packable 18L daypack, 65% off for Mega Sale subscribers." },
  { name: "Coastal Straw Hat", was: "$38.00", now: "$13.30", blurb: "Wide-brim UPF 50+ protection, 65% off through the weekend." },
] as const;

function solandraProductRow(product: (typeof SOLANDRA_PRODUCTS)[number], index: number): string {
  return `
  <tr>
    <td style="padding:20px 24px;border-bottom:1px solid #eeeeee;" colspan="2">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="140" style="vertical-align:top;">
            <img src="https://cdn.solandra-outlet.test/campaigns/summer-mega-sale/product-${index + 1}.jpg"
                 alt="${product.name}" width="120" height="120"
                 style="display:block;width:120px;height:120px;border-radius:6px;background-color:#f0f0f0;">
          </td>
          <td style="vertical-align:top;padding-left:16px;">
            <p style="margin:0 0 4px;font-size:15px;font-weight:bold;color:#1b1f3b;">${product.name}</p>
            <p style="margin:0 0 8px;font-size:13px;color:#888888;">
              <span style="text-decoration:line-through;">${product.was}</span>
              &nbsp;<span style="color:#ff5a36;font-weight:bold;">${product.now}</span>
            </p>
            <p style="margin:0;font-size:13px;color:#555555;line-height:1.5;">${product.blurb}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

const SOLANDRA_TESTIMONIALS = [
  { quote: "The Cascade Weekender survived three connecting flights and still looks new.", name: "— fabricated customer quote, for fixture use only" },
  { quote: "Fastest checkout of any outlet site I have used this year.", name: "— fabricated customer quote, for fixture use only" },
  { quote: "Sizing chart was spot on for the Halcyon Linen Shirt.", name: "— fabricated customer quote, for fixture use only" },
] as const;

function solandraTestimonialRow(testimonial: (typeof SOLANDRA_TESTIMONIALS)[number]): string {
  return `
  <tr>
    <td style="padding:16px 24px;border-bottom:1px solid #eeeeee;">
      <p style="margin:0 0 4px;font-size:14px;color:#333333;font-style:italic;">"${testimonial.quote}"</p>
      <p style="margin:0;font-size:12px;color:#999999;">${testimonial.name}</p>
    </td>
  </tr>`;
}

const SOLANDRA_SALE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Solandra Outlet — Summer Mega Sale</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
  <tr>
    <td align="center" style="padding:24px 0;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="background-color:#1b1f3b;padding:24px;text-align:center;">
            <img src="https://cdn.solandra-outlet.test/logo-white.png" alt="Solandra Outlet" width="180" style="display:block;margin:0 auto;">
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <img src="https://cdn.solandra-outlet.test/campaigns/summer-mega-sale/hero.jpg" alt="Summer Mega Sale — up to 70% off" width="600" style="display:block;width:100%;">
          </td>
        </tr>
        <tr>
          <td style="padding:32px 24px 8px;text-align:center;">
            <h1 style="margin:0 0 12px;font-size:28px;color:#1b1f3b;">SUMMER MEGA SALE — UP TO 70% OFF</h1>
            <p style="margin:0 0 20px;font-size:16px;color:#555555;line-height:1.5;">
              72 hours only. Free shipping on every order over $50. No code needed — discounts are already applied at checkout.
            </p>
            <a href="https://solandra-outlet.test/sale?utm_source=newsletter&amp;utm_campaign=summer-mega-sale"
               style="display:inline-block;padding:14px 32px;background-color:#ff5a36;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold;">
              SHOP THE SALE
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 24px 0;">
            <h2 style="margin:24px 0 0;font-size:18px;color:#1b1f3b;border-bottom:2px solid #ff5a36;display:inline-block;padding-bottom:4px;">
              Today's top markdowns
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${SOLANDRA_PRODUCTS.map((product, index) => solandraProductRow(product, index)).join("\n")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 24px 0;">
            <h2 style="margin:0 0 4px;font-size:18px;color:#1b1f3b;border-bottom:2px solid #ff5a36;display:inline-block;padding-bottom:4px;">
              What shoppers are saying
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${SOLANDRA_TESTIMONIALS.map((testimonial) => solandraTestimonialRow(testimonial)).join("\n")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;text-align:center;">
            <a href="https://solandra-outlet.test/sale?utm_source=newsletter&amp;utm_campaign=summer-mega-sale-footer"
               style="display:inline-block;padding:14px 32px;background-color:#1b1f3b;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold;">
              BROWSE THE FULL SALE
            </a>
          </td>
        </tr>
        <tr>
          <td style="background-color:#1b1f3b;padding:24px;text-align:center;color:#cccccc;font-size:12px;line-height:1.6;">
            <p style="margin:0 0 8px;">Solandra Outlet — 123 Fictional Ave, Nowhere, ZZ 00000</p>
            <p style="margin:0 0 8px;">
              You are receiving this because a Solandra Outlet fixture account subscribed with this address.
            </p>
            <p style="margin:0;">
              <a href="https://solandra-outlet.test/unsubscribe" style="color:#ffffff;">Unsubscribe</a>
              &nbsp;|&nbsp;
              <a href="https://solandra-outlet.test/privacy" style="color:#ffffff;">Privacy Policy</a>
              &nbsp;|&nbsp;
              <a href="https://solandra-outlet.test/preferences" style="color:#ffffff;">Email Preferences</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

// Deterministic spam/promotional fixtures seeded via unauthenticated,
// external-domain SMTP so Stalwart's real spam filter classifies them (see
// ../smtp-seed.ts's seedJunk). All companies, people, and domains below are
// invented; every sender uses a reserved ".test" domain (RFC 2606) and never
// resolves to a real host.
export const SPAM_SEED_EMAILS: SeedEmail[] = [
  {
    // Long HTML newsletter — the workhorse fixture for reading-pane
    // truncation (GH #135). See SOLANDRA_SALE_HTML above.
    messageId: "spam-1@solandra-outlet.test",
    from: "Solandra Outlet <newsletter@solandra-outlet.test>",
    to: "admin@cefiro.test",
    subject: "SUMMER MEGA SALE: up to 70% off + free shipping (72 hours only)",
    body:
      "Solandra Outlet — Summer Mega Sale\r\n\r\n" +
      "Up to 70% off sitewide, free shipping over $50, no code needed. 72 hours only.\r\n\r\n" +
      "Shop the sale: https://solandra-outlet.test/sale\r\n\r\n" +
      "Unsubscribe: https://solandra-outlet.test/unsubscribe",
    html: SOLANDRA_SALE_HTML,
  },
  {
    // Spoofed-sender / phishing shape for the sender-authenticity indicator
    // (GH #136): the display name impersonates "Cefiro" (the fixture's own
    // domain, cefiro.test) while the actual address is an unrelated
    // look-alike domain — classic phishing mismatch, fully fabricated.
    messageId: "spam-2@cefiro-verificacion-segura.test",
    from: "Cefiro Seguridad <cuentas@cefiro-verificacion-segura.test>",
    to: "admin@cefiro.test",
    subject: "Accion requerida: verifica tu cuenta en las proximas 24 horas",
    body:
      "Estimado usuario,\r\n\r\n" +
      "Hemos detectado actividad inusual en tu cuenta de correo. Para evitar la suspension del servicio, " +
      "verifica tu cuenta dentro de las proximas 24 horas siguiendo el siguiente enlace:\r\n\r\n" +
      "https://cefiro-verificacion-segura.test/verificar\r\n\r\n" +
      "Si no completas este paso, tu acceso sera restringido de forma permanente.\r\n\r\n" +
      "Atentamente,\r\nEquipo de Seguridad",
  },
  {
    // Short, plainer promotional message so the fixtures are not all one
    // shape.
    messageId: "spam-3@rinconandino.test",
    from: "Cafe Rincon Andino <hola@rinconandino.test>",
    to: "admin@cefiro.test",
    subject: "2x1 en tu bebida favorita esta semana",
    body:
      "Hola,\r\n\r\n" +
      "Esta semana tenemos 2x1 en todas las bebidas calientes y frias de Cafe Rincon Andino. " +
      "Valido de lunes a viernes, de 3pm a 6pm, en todas nuestras sucursales.\r\n\r\n" +
      "Te esperamos,\r\nEquipo Rincon Andino",
  },
];
