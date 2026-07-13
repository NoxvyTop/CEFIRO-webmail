import { expect, test } from "@playwright/test";

test("Ajustes navigates to /settings and renders its sections inside the shell", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Sesión iniciada como/ }).click();
  await page.getByRole("menuitem", { name: "Ajustes" }).click();

  await expect(page).toHaveURL("/settings");
  await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Firmas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Filtros" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Respuestas automáticas" })).toBeVisible();
});

test("Administración navigates to /admin and renders the users table inside the shell", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Sesión iniciada como/ }).click();
  await page.getByRole("menuitem", { name: "Administración" }).click();

  await expect(page).toHaveURL("/admin");
  await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Correo" })).toBeVisible();
});

test("an unknown route redirects to the mail shell at /", async ({ page }) => {
  await page.goto("/ruta-que-no-existe");

  await expect(page).toHaveURL("/");
  await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();
});

test("searching from /settings navigates to / with the query", async ({ page }) => {
  await page.goto("/settings");

  const search = page.getByRole("searchbox", { name: "Buscar en el correo" });
  await search.fill("factura");
  await search.press("Enter");

  await expect(page).toHaveURL("/?q=factura");
});
