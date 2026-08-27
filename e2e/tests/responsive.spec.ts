import { expect, test, type Locator, type Page } from "@playwright/test";

async function documentOverflow(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}

/**
 * GH #252: the document-level check above cannot see the failure GH #249 was
 * about. Both overflowing rows sit inside a scroll container — the composer
 * panel is `overflow-y-auto` (which makes the x axis `auto` too, per the
 * overflow spec) and the reader column is `overflow-x-hidden` — so a row that
 * runs past its box is scrolled or clipped INSIDE that container and the page
 * itself never grows a millimetre. That is exactly how a control ends up
 * unreachable while every page-level assertion still passes.
 *
 * Measured on the row itself, this is the direct question: does this row fit in
 * the space it has?
 */
async function elementOverflow(locator: Locator) {
  return locator.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
}

/** Every control in the row is inside the viewport, not just laid out somewhere. */
async function expectAllInsideViewport(row: Locator, viewportWidth: number) {
  const buttons = row.getByRole("button");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `control ${index} has no layout box`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
  }
}

test.describe("narrow viewport (520x800)", () => {
  test.use({ viewport: { width: 520, height: 800 } });

  test("no horizontal scroll on /", async ({ page }) => {
    await page.goto("/");

    const overflow = await documentOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("no horizontal scroll on /settings", async ({ page }) => {
    await page.goto("/settings");

    const overflow = await documentOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("the CÉFIRO wordmark is hidden while the logo still shows", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("header").getByText("CÉFIRO")).toBeHidden();
    await expect(page.locator("header svg").first()).toBeVisible();
  });
});

// GH #252: 520x800 was the only viewport this suite ever exercised, on two
// static routes, with neither the reader nor the composer open. That is why
// #249 shipped: the rows that overflow are inside those two screens, and at
// 375px — the width the design docs treat as the phone floor — not at 520.
//
// The reader and composer tests need the seeded mailbox, like the other mail
// specs. Bring the mail stack up first:
//   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
//   docker compose -f docker-compose.e2e.yml up -d --build
//   cd e2e && E2E_STALWART_URL=http://localhost:8096 bunx playwright test tests/responsive.spec.ts
test.describe("phone viewport (375x812)", () => {
  const VIEWPORT = { width: 375, height: 812 };
  test.use({ viewport: VIEWPORT });

  test("no horizontal scroll on /", async ({ page }) => {
    await page.goto("/");

    const overflow = await documentOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("no horizontal scroll on /settings", async ({ page }) => {
    await page.goto("/settings");

    const overflow = await documentOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("the composer's action row fits, with every control reachable (GH #249)", async ({
    page,
  }) => {
    await page.goto("/");

    // Below `lg` the sidebar is a drawer, so Redactar lives behind the
    // hamburger rather than in a static column.
    await page.getByRole("button", { name: "Menú de navegación" }).click();
    await page.getByRole("button", { name: "Redactar", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Nuevo mensaje" });
    await expect(dialog).toBeVisible();

    const actions = dialog.getByTestId("composer-actions");
    await expect(actions).toBeVisible();

    const overflow = await elementOverflow(actions);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await expectAllInsideViewport(actions, VIEWPORT.width);

    // Descartar is the control the overflow used to push off the edge, so it
    // gets the one behavioural check: it is not merely laid out, it works.
    await dialog.getByRole("button", { name: "Descartar" }).click();
    await expect(dialog).toBeHidden();
  });

  test("the reader's reply row fits, with every control reachable (GH #249)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Below `lg` opening a conversation replaces the list with the reader, so
    // the reply row gets the full 375px column and nothing else competes for it.
    await page.getByRole("option").first().click();

    const reader = page.getByRole("region", { name: "Lectura" });
    await expect(reader).toBeVisible();

    const footer = page.getByTestId("thread-footer-actions");
    await expect(footer).toBeVisible();

    const overflow = await elementOverflow(footer);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await expectAllInsideViewport(footer, VIEWPORT.width);

    // Reenviar is the one the clipping used to swallow.
    await footer.getByRole("button", { name: "Reenviar" }).click();
    // The dialog is named by compose mode now (GH #269): forwarding names it
    // "Reenviar", not the old blanket "Nuevo mensaje".
    await expect(page.getByRole("dialog", { name: "Reenviar" })).toBeVisible();
  });

  test("the reader's top action bar still fits too (GH #214 at 375px)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("alert")).toHaveCount(0);

    await page.getByRole("option").first().click();

    const actionsBar = page.getByTestId("thread-actions-bar");
    await expect(actionsBar).toBeVisible();

    // #214 chose a scrollable axis here rather than wrapping, so this row is
    // allowed to overflow — what it must never be is CLIPPED, which is the
    // state that made Eliminar and Etiquetas unreachable.
    const overflowStyle = await actionsBar.evaluate(
      (el) => getComputedStyle(el).overflowX,
    );
    expect(overflowStyle).not.toBe("hidden");
  });
});

test.describe("wide viewport (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the CÉFIRO wordmark shows alongside the logo", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();
    await expect(page.locator("header svg").first()).toBeVisible();
  });
});
