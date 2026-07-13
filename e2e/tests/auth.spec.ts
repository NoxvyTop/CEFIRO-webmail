import { expect, test } from "@playwright/test";

// These specs exercise the unauthenticated login screen, so each test starts
// from a fresh context with no storageState instead of the seeded session.
test.use({ storageState: { cookies: [], origins: [] } });

test("bootstrap mode shows only the emergency form, not SSO sign-in", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Acceso de emergencia" })).toBeVisible();
  await expect(page.getByLabel("Usuario")).toBeVisible();
  await expect(page.getByLabel("Contraseña")).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();

  await expect(page.getByRole("link", { name: "Iniciar sesión con SSO" })).toHaveCount(0);
});

test("wrong password shows the invalid-credential error and does not navigate", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Usuario").fill("nobody@example.com");
  await page.getByLabel("Contraseña").fill("definitely-wrong");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByText("Credencial inválida")).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Acceso de emergencia" })).toBeVisible();
});
