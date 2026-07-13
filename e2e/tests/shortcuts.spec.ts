import { expect, test } from "@playwright/test";

test("? opens the Atajos dialog with its rows, and Esc closes it", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Buscar en el correo" });
  await expect(search).toBeVisible();

  await page.keyboard.press("?");

  const dialog = page.getByRole("dialog", { name: "Atajos" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Moverse por la lista")).toBeVisible();
  await expect(dialog.getByText("Archivar correo")).toBeVisible();
  await expect(dialog.getByText("Destacar correo")).toBeVisible();
  await expect(dialog.getByText("Responder")).toBeVisible();
  await expect(dialog.getByText("Redactar")).toBeVisible();
  await expect(dialog.getByText("Buscar")).toBeVisible();
  await expect(dialog.getByText("Cerrar / salir")).toBeVisible();
  await expect(dialog.locator("dt")).toHaveCount(7);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("clicking the backdrop closes the Atajos dialog", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Buscar en el correo" })).toBeVisible();

  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Atajos" });
  await expect(dialog).toBeVisible();

  // Click outside the centered dialog panel, on the backdrop itself.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
});

test("the header ? Atajos button also opens the dialog", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "? Atajos" }).click();

  await expect(page.getByRole("dialog", { name: "Atajos" })).toBeVisible();
});

test("/ focuses the search input", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Buscar en el correo" });
  await expect(search).toBeVisible();

  await page.keyboard.press("/");

  await expect(search).toBeFocused();
});
