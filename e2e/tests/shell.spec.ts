import { expect, test } from "@playwright/test";

test("header shows the brand, search box and avatar", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Buscar en el correo" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sesión iniciada como/ })).toBeVisible();
});

test("profile menu opens with Ajustes, Administración, theme and Cerrar sesión, and Escape closes it", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Sesión iniciada como/ }).click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Ajustes" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Administración" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Cambiar a tema/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Cerrar sesión" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("theme toggle flips data-theme and localStorage, and persists across reload", async ({ page }) => {
  await page.goto("/");

  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);

  await page.getByRole("button", { name: /Sesión iniciada como/ }).click();
  await page.getByRole("menuitem", { name: /Cambiar a tema/ }).click();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(initialTheme);

  const toggledTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const storedTheme = await page.evaluate(() => localStorage.getItem("cefiro-theme"));
  expect(storedTheme).toBe(toggledTheme);

  await page.reload();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(toggledTheme);
});
