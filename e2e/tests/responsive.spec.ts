import { expect, test } from "@playwright/test";

test.describe("narrow viewport (520x800)", () => {
  test.use({ viewport: { width: 520, height: 800 } });

  test("no horizontal scroll on /", async ({ page }) => {
    await page.goto("/");

    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("no horizontal scroll on /settings", async ({ page }) => {
    await page.goto("/settings");

    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("the CÉFIRO wordmark is hidden while the logo still shows", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("header").getByText("CÉFIRO")).toBeHidden();
    await expect(page.locator("header svg").first()).toBeVisible();
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
