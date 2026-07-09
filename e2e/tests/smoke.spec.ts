import { expect, test } from "@playwright/test";

test("authenticated shell renders with the Cefiro brand and profile menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("CÉFIRO")).toBeVisible();
  await expect(page.getByRole("button", { name: /Redactar/ })).toBeVisible();
});

test("unauthenticated context lands on the login screen", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CÉFIRO" })).toBeVisible();
  await expect(page.getByText("Acceso de emergencia")).toBeVisible();
  await context.close();
});
