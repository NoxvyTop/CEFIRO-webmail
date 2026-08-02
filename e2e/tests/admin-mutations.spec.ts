import { expect, test, type Page } from "@playwright/test";

/**
 * The admin console's write paths — GH #248.
 *
 * navigation.spec.ts reached /admin and asserted the users table renders, which
 * proves the route and the query. Every MUTATION behind it was uncovered: user
 * creation, the role select, the archive/reactivate confirmation, the mailbox
 * credential, the instance toggle. Those are the highest-privilege buttons in
 * the product — one of them decides who else can reach this console, another
 * decides whether an account can sign in at all — and they are exactly the ones
 * a unit test cannot fully vouch for, because what makes them correct is that
 * the change survives a round trip to Postgres and comes back in the next read.
 *
 * Every assertion below therefore reads the value back from a re-fetched table
 * rather than from the optimistic UI: each mutation invalidates the users query
 * and the row is re-rendered from the server's answer.
 *
 * Scope discipline: the specs share one database and one session, so this file
 * only ever mutates a user it created itself, with a per-run address. Touching
 * the seeded account would end the session the rest of the suite runs under —
 * and archiving it would end it permanently.
 */

const SUBJECT_EMAIL = `admin-mutations-${crypto.randomUUID().slice(0, 8)}@cefiro.test`;
const SUBJECT_NAME = "Sujeto de pruebas";

/** Opens /admin and switches to the Usuarios section, where the writes live. */
async function openUsersSection(page: Page): Promise<void> {
  await page.goto("/admin");
  await page
    .getByRole("navigation", { name: "Secciones de administración" })
    .getByRole("button", { name: "Usuarios" })
    .click();
}

test.describe.configure({ mode: "serial" });

test.describe("admin mutations", () => {
  test("creating a user persists it into the table", async ({ page }) => {
    await openUsersSection(page);

    // `exact` on every one of these. getByLabel is a case-insensitive substring
    // match by default, and "Correo" alone resolves to three controls: this
    // field, the users search box ("Buscar por nombre o correo…") and the
    // shell's own mail search ("Buscar en el correo…").
    await page.getByLabel("Correo", { exact: true }).fill(SUBJECT_EMAIL);
    await page.getByLabel("Nombre", { exact: true }).fill(SUBJECT_NAME);
    await page.getByLabel("Contraseña del buzón (opcional)").fill("buzon-de-pruebas");
    await page.getByRole("button", { name: "Crear" }).click();

    const row = page.getByRole("row").filter({ hasText: SUBJECT_EMAIL });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(SUBJECT_NAME);
    // Created with a mail password, so the account comes back already linked —
    // the credential was stored and encrypted, not dropped on the floor.
    await expect(row).toContainText("Buzón vinculado");
    await expect(row).toContainText("Activo");
    // The form clears on success; a form that keeps its values is how the same
    // account gets created twice.
    await expect(page.getByLabel("Correo", { exact: true })).toHaveValue("");
  });

  test("creating the same address again is refused rather than duplicated", async ({ page }) => {
    await openUsersSection(page);

    await page.getByLabel("Correo", { exact: true }).fill(SUBJECT_EMAIL);
    await page.getByLabel("Nombre", { exact: true }).fill("Duplicado");
    await page.getByRole("button", { name: "Crear" }).click();

    // The server answers 409 and the console has to surface it: silently doing
    // nothing looks identical to success from the operator's side.
    //
    // The specific message, not the generic one: GH #46 gave the admin 409s
    // their own translations, so "No se pudo completar la acción" is now the
    // fallback for a code nobody mapped — asserting it here would pin the
    // vaguer behaviour that issue removed.
    await expect(page.getByRole("alert")).toHaveText("Ya existe un usuario con ese correo");
    await expect(page.getByRole("row").filter({ hasText: SUBJECT_EMAIL })).toHaveCount(1);
  });

  test("promoting a user to admin survives a reload", async ({ page }) => {
    await openUsersSection(page);

    const row = page.getByRole("row").filter({ hasText: SUBJECT_EMAIL });
    await expect(row.getByLabel("Rol")).toHaveValue("employee");
    await row.getByLabel("Rol").selectOption("admin");

    // The select is controlled by the query's data, not by local state, so it
    // snaps back to "employee" until the PUT lands and the invalidated query
    // returns. Settling on "admin" here IS the round trip — and waiting for it
    // is also what keeps the reload below from aborting an in-flight request.
    await expect(row.getByLabel("Rol")).toHaveValue("admin");

    // Then re-read from a cold page: this mutation is what grants access to
    // this console, so "the dropdown changed" is not the claim worth making.
    await page.reload();
    await page
      .getByRole("navigation", { name: "Secciones de administración" })
      .getByRole("button", { name: "Usuarios" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: SUBJECT_EMAIL }).getByLabel("Rol"),
    ).toHaveValue("admin");
  });

  test("archiving asks for confirmation first, and reactivating does not", async ({ page }) => {
    await openUsersSection(page);
    const row = page.getByRole("row").filter({ hasText: SUBJECT_EMAIL });

    // First click only arms the action. Archiving is the closest thing this
    // product has to deleting someone, so a single misplaced click must not do
    // it — and the button has to say that it is now armed.
    await row.getByRole("button", { name: "Archivar" }).click();
    await expect(row).toContainText("Activo");
    await expect(row.getByRole("button", { name: "Confirmar archivado" })).toBeVisible();

    await row.getByRole("button", { name: "Confirmar archivado" }).click();
    await expect(row).toContainText("Archivado");
    // Confirmation is consumed, not sticky: the row now offers the way back.
    await expect(row.getByRole("button", { name: "Reactivar" })).toBeVisible();

    // Reactivating is not destructive, so it takes effect on the first click.
    await row.getByRole("button", { name: "Reactivar" }).click();
    await expect(row).toContainText("Activo");
    await expect(row.getByRole("button", { name: "Archivar" })).toBeVisible();
  });

  test("linking a mailbox from the row stores the credential", async ({ page }) => {
    await openUsersSection(page);

    // A second account, created WITHOUT a mail password, so it starts unlinked
    // and the row's own credential form is the thing under test.
    const unlinked = `admin-unlinked-${crypto.randomUUID().slice(0, 8)}@cefiro.test`;
    await page.getByLabel("Correo", { exact: true }).fill(unlinked);
    await page.getByLabel("Nombre", { exact: true }).fill("Sin buzón");
    await page.getByRole("button", { name: "Crear" }).click();

    const row = page.getByRole("row").filter({ hasText: unlinked });
    await expect(row).toContainText("Sin vincular");

    await row.getByRole("button", { name: "Vincular buzón" }).click();
    await row.getByLabel("Vincular buzón").fill("credencial-de-buzon");
    await row.getByRole("button", { name: "Guardar" }).click();

    // The badge flips only because the users query was invalidated and the row
    // came back from the server saying mailboxLinked — the form closing on its
    // own would prove nothing.
    await expect(row).toContainText("Buzón vinculado");
    await expect(row.getByRole("button", { name: "Vincular buzón" })).toBeVisible();
  });

  test("the instance footer toggle persists across a reload", async ({ page }) => {
    await page.goto("/admin");
    const nav = page.getByRole("navigation", { name: "Secciones de administración" });
    await nav.getByRole("button", { name: "Ajustes" }).click();

    const toggle = page.getByRole("checkbox", { name: /Enviado con CÉFIRO/ });
    const wasChecked = await toggle.isChecked();

    // `click`, not `setChecked`: the box is controlled by the query's data, so
    // React reverts it the instant it is clicked and only flips once the PUT
    // lands and the invalidated query returns. setChecked reads the DOM back
    // immediately and would fail on that revert — which is a fair description
    // of why this assertion is worth making at all.
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: !wasChecked });

    // This setting changes what every reader in the instance renders, so it has
    // to be stored, not just remembered by the open tab.
    await page.reload();
    await nav.getByRole("button", { name: "Ajustes" }).click();
    await expect(toggle).toBeChecked({ checked: !wasChecked });

    // Restored, so the reader specs see the instance they expect however this
    // file ends up scheduled relative to them.
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: wasChecked });
  });
});
