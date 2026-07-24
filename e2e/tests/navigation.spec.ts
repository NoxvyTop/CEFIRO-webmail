import { expect, test } from "@playwright/test";

test("Ajustes navigates to /settings and renders its sectioned console inside the shell", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Sesión iniciada como/ }).click();
  await page.getByRole("menuitem", { name: "Ajustes" }).click();

  await expect(page).toHaveURL("/settings");
  await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();

  // The settings console opens on the Perfil section by default (added with the
  // user-profile feature); the section nav lists all sections, mirroring the
  // /admin sectioned console.
  const nav = page.getByRole("navigation", { name: "Secciones de ajustes" });
  await expect(nav.getByRole("button", { name: "Perfil" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "Firmas" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Filtros" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Ausencia" })).toBeVisible();

  // Switching to Firmas shows the Firmas section.
  await nav.getByRole("button", { name: "Firmas" }).click();
  await expect(page.getByRole("heading", { name: "Firmas" })).toBeVisible();

  // Switching to Filtros hides Firmas and shows the Filtros section.
  await nav.getByRole("button", { name: "Filtros" }).click();
  await expect(page.getByRole("heading", { name: "Filtros" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Firmas" })).not.toBeVisible();

  // Switching to Ausencia hides Filtros and shows the automatic-reply section.
  await nav.getByRole("button", { name: "Ausencia" }).click();
  await expect(page.getByRole("heading", { name: "Respuestas automáticas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Filtros" })).not.toBeVisible();
});

test("Administración navigates to /admin and renders the users table inside the shell", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Sesión iniciada como/ }).click();
  await page.getByRole("menuitem", { name: "Administración" }).click();

  await expect(page).toHaveURL("/admin");
  await expect(page.locator("header").getByText("CÉFIRO")).toBeVisible();
  // The admin console opens on the Resumen section; the users table lives under
  // the Usuarios section, so switch to it before asserting the table.
  await page
    .getByRole("navigation", { name: "Secciones de administración" })
    .getByRole("button", { name: "Usuarios" })
    .click();
  await expect(page.getByRole("table")).toBeVisible();
  // Slice 3 merged the email + name columns into a single identity column,
  // whose header uses admin.columns.name ("Nombre").
  await expect(page.getByRole("columnheader", { name: "Nombre" })).toBeVisible();
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
