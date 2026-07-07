# Céfiro Plan 1/4 — Visual Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Céfiro identity foundation: design tokens (Night/Light themes) as CSS custom properties mapped into Tailwind v4, self-hosted Space Grotesk, the animated logo and avatar components, the theme toggle, and the re-skinned login page.

**Architecture:** Tailwind v4 CSS-first: tokens live as plain custom properties under `:root[data-theme=…]` and are exposed as utilities via `@theme inline` (e.g. `bg-panel`, `text-ink`, `border-line`, `bg-accent`). Theme preference in localStorage (`cefiro-theme`), applied pre-render by an inline snippet in `index.html` (no flash). Fonts via `@fontsource-variable/space-grotesk` (same self-hosting mechanism as the existing Inter dependency — bundled at build, zero runtime internet). Reference design: `docs/design/cefiro/README.md` (tokens are FINAL — transcribe exactly).

**Tech Stack:** existing + one dependency: `@fontsource-variable/space-grotesk`. No server changes.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys; conventional commits; no AI attribution; no compiled `.js` committed.
- TDD where a task has logic (Avatar hashing, theme hook); transcription tasks verify via typecheck + full web suite.
- **Design tokens are transcribed EXACTLY from `docs/design/cefiro/README.md`** — no invented colors, no "close enough" hex values.
- **Zero runtime internet**: the font comes from the npm package (bundled by Vite), NEVER from Google Fonts URLs.
- Existing tests must keep passing: they select by i18n text/roles/labels, so keep every `t()` key, `aria-label`, `htmlFor`/`id` pair (`bootstrap-email`, `bootstrap-password`) intact unless a step says otherwise.
- **This branch ships as ONE PR after Plan 3** — mid-branch screens not yet re-skinned may look off on the dark default; that is expected and not a defect to "fix" by reverting the theme.
- NEVER kill processes globally; every task runs `bun run typecheck` (apps/web) and the web suite before committing.
- Branch: `init-ui-polish`.

---

### Task 1: Tokens, fonts, theme bootstrap, brand title

**Files:**
- Create: `apps/web/src/app/theme.css`, `apps/web/public/favicon.svg`
- Modify: `apps/web/src/index.css`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/package.json` (dependency), `apps/web/src/app/locales/en.json` + `es.json` (`app.title` + new `app.tagline`)

**Interfaces (produces):** Tailwind utilities `bg-canvas`, `bg-panel`, `text-ink`, `text-muted`, `border-line`, `bg-accent`, `text-accent`, `text-accent-ink`, `bg-soft`, `bg-hover`, `bg-sel` (and every other prefix Tailwind derives from the `--color-*` names); keyframes `logoSpin`, `windFlow`, `twinkle`, `fadeUp`. All later tasks/plans rely on these exact names.

- [ ] **Step 1: Add the font dependency**

Run: `cd apps/web && bun add @fontsource-variable/space-grotesk`
Expected: dependency added to package.json (self-hosted woff2s, same mechanism as `@fontsource-variable/inter`).

- [ ] **Step 2: Create `apps/web/src/app/theme.css`** (tokens transcribed from the design README):

```css
/* Cefiro design tokens — source of truth: docs/design/cefiro/README.md */

:root,
:root[data-theme="night"] {
  --bg: #0a0b10;
  --panel: #12141c;
  --ink: #eceef4;
  --muted: #8b90a2;
  --line: #232838;
  --accent: #6fe3c1;
  --accent-ink: #07130f;
  --soft: #171a24;
  --hover: #191d28;
  --sel: #15302b;
}

:root[data-theme="light"] {
  --bg: #f1f4f4;
  --panel: #ffffff;
  --ink: #101318;
  --muted: #66707e;
  --line: #e2e7e9;
  --accent: #0fa383;
  --accent-ink: #ffffff;
  --soft: #edf7f3;
  --hover: #f3f7f6;
  --sel: #dcf2ea;
}

@theme inline {
  --color-canvas: var(--bg);
  --color-panel: var(--panel);
  --color-ink: var(--ink);
  --color-muted: var(--muted);
  --color-line: var(--line);
  --color-accent: var(--accent);
  --color-accent-ink: var(--accent-ink);
  --color-soft: var(--soft);
  --color-hover: var(--hover);
  --color-sel: var(--sel);
  --font-sans: "Space Grotesk Variable", system-ui, sans-serif;
}

@keyframes logoSpin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes windFlow {
  to {
    stroke-dashoffset: -96;
  }
}

@keyframes twinkle {
  0%,
  100% {
    opacity: 0.25;
    transform: scale(0.7);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 3: Replace `apps/web/src/index.css`**:

```css
@import "tailwindcss";
@import "./app/theme.css";

body {
  font-family: "Space Grotesk Variable", system-ui, sans-serif;
  background: var(--bg);
  color: var(--ink);
}
```

- [ ] **Step 4: Swap the font import in `apps/web/src/main.tsx`** — replace line 1:

```ts
import "@fontsource-variable/space-grotesk";
```

Then remove the `@fontsource-variable/inter` dependency: `cd apps/web && bun remove @fontsource-variable/inter`.

- [ ] **Step 5: Update `apps/web/index.html`**:

```html
<!doctype html>
<html lang="es" data-theme="night">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Céfiro</title>
    <script>
      try {
        var cefiroTheme = localStorage.getItem("cefiro-theme");
        if (cefiroTheme === "light" || cefiroTheme === "night") {
          document.documentElement.dataset.theme = cefiroTheme;
        }
      } catch (e) {
        /* storage unavailable — keep default */
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `apps/web/public/favicon.svg`** (static wind mark, accent color):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <g fill="none" stroke="#6FE3C1" stroke-width="2.6" stroke-linecap="round">
    <path d="M9 15h13a3.6 3.6 0 1 0-3.6-6.3" />
    <path d="M7 21h19a3.6 3.6 0 1 1 3.6 6.3" />
    <path d="M9 27h10" />
  </g>
</svg>
```

- [ ] **Step 7: Brand strings** — in BOTH locale files change `app.title` to `"Céfiro"` and add `"tagline": "correo del ecosistema"` inside the `app` block (same value in en and es — it is brand copy).

- [ ] **Step 8: Full web suite + typecheck + build**

Run: `cd apps/web && bun run test` — Expected: PASS (tests select via i18n keys, which still resolve; `app.title` assertions now resolve to "Céfiro" through the same key).
Run: `cd apps/web && bun run typecheck` — Expected: no errors.
Run: `cd apps/web && bun run build` — Expected: build OK; `dist/assets` contains space-grotesk woff2 files and NO inter files.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/theme.css apps/web/src/index.css apps/web/index.html apps/web/public/favicon.svg apps/web/src/main.tsx apps/web/package.json apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json bun.lock
git commit -m "feat(web): cefiro design tokens, space grotesk and theme bootstrap"
```

(If the lockfile has a different name at repo root, add that path instead.)

---

### Task 2: CefiroLogo + Avatar components

**Files:**
- Create: `apps/web/src/app/ui/CefiroLogo.tsx`, `apps/web/src/app/ui/Avatar.tsx`
- Test: `apps/web/src/app/ui/ui.test.tsx`

**Interfaces (produces — Plans 1–3 rely on these):**
- `CefiroLogo({ size?: number })` — default 32; animated inline SVG, `aria-hidden`, colored via `currentColor` (`text-accent`).
- `Avatar({ name: string | null; email: string; size?: number })` — default 38; also exports `avatarColor(key: string): string` and `initials(name: string | null, email: string): string` (pure, tested).

- [ ] **Step 1: Write the failing tests** — `apps/web/src/app/ui/ui.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, avatarColor, initials } from "./Avatar";
import { CefiroLogo } from "./CefiroLogo";

describe("avatarColor", () => {
  it("is deterministic and case-insensitive", () => {
    expect(avatarColor("carla@noxvytop.com")).toBe(avatarColor("CARLA@noxvytop.com"));
  });

  it("returns a color from the design palette", () => {
    expect(avatarColor("x@y.com")).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe("initials", () => {
  it("uses first and second word initials from the name", () => {
    expect(initials("Carla Bosch", "carla@noxvytop.com")).toBe("CB");
  });

  it("falls back to the email when the name is empty", () => {
    expect(initials(null, "lucia.ferrer@noxvytop.com")).toBe("LF");
    expect(initials("  ", "solo@noxvytop.com")).toBe("SN");
  });
});

describe("components", () => {
  it("renders the avatar initials", () => {
    render(<Avatar name="Carla Bosch" email="carla@noxvytop.com" />);
    expect(screen.getByText("CB")).toBeInTheDocument();
  });

  it("renders the logo as decorative svg", () => {
    const { container } = render(<CefiroLogo size={72} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "72");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/app/ui/ui.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement** — `apps/web/src/app/ui/Avatar.tsx`:

```tsx
const AVATAR_COLORS = [
  "#3E8E7E",
  "#4E6E9E",
  "#6E5E9E",
  "#8E6E4E",
  "#4E8E5E",
  "#5E7E9E",
  "#9E5E6E",
  "#5E9E8E",
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function avatarColor(key: string): string {
  return AVATAR_COLORS[hashString(key.toLowerCase()) % AVATAR_COLORS.length]!;
}

export function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase();
}

type AvatarProps = { name: string | null; email: string; size?: number };

export function Avatar({ name, email, size = 38 }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: avatarColor(email),
        color: "#F4FBF8",
        fontSize: Math.round(size * 0.37),
      }}
    >
      {initials(name, email)}
    </span>
  );
}
```

And `apps/web/src/app/ui/CefiroLogo.tsx` (SVG spec from the design README):

```tsx
type CefiroLogoProps = { size?: number };

export function CefiroLogo({ size = 32 }: CefiroLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className="text-accent"
    >
      <circle
        cx="20"
        cy="20"
        r="18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="3.5 6.5"
        opacity="0.45"
        style={{ transformOrigin: "center", animation: "logoSpin 28s linear infinite" }}
      />
      <g stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeDasharray="12 36">
        <path
          d="M9 15h13a3.6 3.6 0 1 0-3.6-6.3"
          style={{ animation: "windFlow 3.4s linear infinite" }}
        />
        <path
          d="M7 21h19a3.6 3.6 0 1 1 3.6 6.3"
          style={{ animation: "windFlow 3.4s linear infinite", animationDelay: "-1.1s" }}
        />
        <path d="M9 27h10" style={{ animation: "windFlow 3.4s linear infinite", animationDelay: "-2.2s" }} />
      </g>
      <circle
        cx="33"
        cy="8"
        r="1.6"
        fill="currentColor"
        stroke="none"
        style={{ transformOrigin: "33px 8px", animation: "twinkle 2.4s ease-in-out infinite" }}
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- src/app/ui/ui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/app/ui/CefiroLogo.tsx apps/web/src/app/ui/Avatar.tsx apps/web/src/app/ui/ui.test.tsx
git commit -m "feat(web): cefiro animated logo and avatar components"
```

---

### Task 3: Theme hook + header toggle + basic header tokens

**Files:**
- Create: `apps/web/src/app/ui/useTheme.ts`
- Modify: `apps/web/src/app/App.tsx` (toggle button in the header; header gets `bg-panel`/`border-line`/`text-ink` base so the shell is readable on the dark default — the FULL header re-skin is Plan 2)
- Modify: `apps/web/src/app/locales/en.json` + `es.json` (`app.themeLight`, `app.themeNight`)
- Test: `apps/web/src/app/ui/use-theme.test.tsx`

**Interfaces (produces):** `useTheme(): { theme: "night" | "light"; toggleTheme: () => void }` — reads/writes localStorage key `cefiro-theme`, mirrors to `document.documentElement.dataset.theme`.

- [ ] **Step 1: Write the failing tests** — `apps/web/src/app/ui/use-theme.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "./useTheme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("useTheme", () => {
  it("defaults to night and applies it to the document", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("reads a stored light preference", () => {
    localStorage.setItem("cefiro-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggles, persists and applies", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem("cefiro-theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/app/ui/use-theme.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `apps/web/src/app/ui/useTheme.ts`:

```ts
import { useEffect, useState } from "react";

export type Theme = "night" | "light";

const STORAGE_KEY = "cefiro-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "night") return stored;
  } catch {
    // storage unavailable — use the default
  }
  return "night";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage unavailable — the preference just won't persist
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((current) => (current === "night" ? "light" : "night"));
  }

  return { theme, toggleTheme };
}
```

- [ ] **Step 4: Wire the toggle into the header** — in `apps/web/src/app/App.tsx`: call `const { theme, toggleTheme } = useTheme();` in the component, change the header element classes from `flex items-center gap-4 border-b px-4 py-2` to `flex items-center gap-4 border-b border-line bg-panel px-4 py-2 text-ink`, and add this button right before the sign-out button:

```tsx
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={t(theme === "night" ? "app.themeLight" : "app.themeNight")}
          className="rounded-md border border-line px-2 py-1 text-sm"
        >
          {theme === "night" ? "☀" : "🌙"}
        </button>
```

Add the i18n keys inside `app` in both locales:
- en: `"themeLight": "Switch to light theme", "themeNight": "Switch to night theme"`
- es: `"themeLight": "Cambiar a tema claro", "themeNight": "Cambiar a tema noche"`

- [ ] **Step 5: Run the new tests + full web suite**

Run: `cd apps/web && bun run test -- src/app/ui/use-theme.test.tsx` — Expected: PASS.
Run: `cd apps/web && bun run test` — Expected: PASS (header text nodes unchanged).

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/app/ui/useTheme.ts apps/web/src/app/ui/use-theme.test.tsx apps/web/src/app/App.tsx apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json
git commit -m "feat(web): night/light theme toggle persisted in localstorage"
```

---

### Task 4: Login re-skin

**Files:**
- Modify: `apps/web/src/features/auth/LoginPage.tsx`
- Modify: `apps/web/src/app/locales/en.json` + `es.json` (`auth.subtitle`, `auth.orCredentials`, `auth.recoveryNotice`)
- Test: `apps/web/src/features/auth/login-bootstrap.test.tsx` (add the recovery-notice assertion)

**Interfaces:**
- Consumes: `CefiroLogo` (Task 2), tokens (Task 1).
- Behavior contract (MUST NOT change): SSO link href `/api/auth/login`; bootstrap form only when `mode?.bootstrapMode === true` with the same `aria-label`, `htmlFor`/`id` pairs (`bootstrap-email`, `bootstrap-password`), submit via `bootstrapLogin`; error handling unchanged. NEW: when `mode` is loaded and `bootstrapMode` is false, show the recovery notice (design handoff: credentials-disabled state).

- [ ] **Step 1: Write the failing test** — add to `apps/web/src/features/auth/login-bootstrap.test.tsx` (mirror the existing bootstrapMode:false test's setup):

```tsx
  it("shows the recovery notice when credentials are disabled", async () => {
    // same stubbing as the existing bootstrapMode:false case
    expect(
      await screen.findByText(i18n.t("auth.recoveryNotice")),
    ).toBeInTheDocument();
  });
```

(Adapt to the file's exact stub helper; if the file asserts with literal Spanish strings instead of i18n.t, follow the file's own style.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bun run test -- src/features/auth/login-bootstrap.test.tsx`
Expected: FAIL — key/notice missing.

- [ ] **Step 3: Add i18n keys** in `auth` (both locales):

- en: `"subtitle": "Sign in to your team's mail", "orCredentials": "or with credentials", "recoveryNotice": "Credential access is disabled. Available only in recovery mode."`
- es: `"subtitle": "Inicia sesión en el correo de tu equipo", "orCredentials": "o con credenciales", "recoveryNotice": "El acceso con credenciales está deshabilitado. Disponible solo en modo recuperación."`

- [ ] **Step 4: Re-skin `LoginPage.tsx`** — keep ALL logic (imports, state, `fetchMode`, `handleBootstrapSubmit`, `KNOWN_ERRORS`) and replace only the returned JSX:

```tsx
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-4">
      <div className="flex flex-col items-center gap-3">
        <CefiroLogo size={72} />
        <h1 className="text-[19px] font-bold tracking-[0.32em] text-ink">CÉFIRO</h1>
        <p className="text-sm text-muted">{t("auth.subtitle")}</p>
      </div>
      {error && KNOWN_ERRORS.has(error) && (
        <p className="text-sm text-[#F26565]">{t(`auth.errors.${error}`)}</p>
      )}
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-2xl border border-line bg-panel p-7 shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
        <a
          href="/api/auth/login"
          className="flex h-[46px] items-center justify-center gap-2 rounded-[11px] bg-accent px-4 font-semibold text-accent-ink shadow-[0_2px_14px_rgba(111,227,193,0.25)] transition hover:brightness-[1.07] active:scale-[0.98]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          {t("auth.signIn")}
        </a>
        {mode?.bootstrapMode === true && (
          <>
            <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted">
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
              {t("auth.orCredentials")}
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
            </div>
            <form
              onSubmit={handleBootstrapSubmit}
              aria-label={t("auth.bootstrap.title")}
              className="flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor="bootstrap-email" className="text-muted">
                  {t("auth.bootstrap.email")}
                </label>
                <input
                  id="bootstrap-email"
                  type="text"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-11 rounded-[10px] border border-line bg-soft px-3 text-ink outline-none focus:border-accent"
                />
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor="bootstrap-password" className="text-muted">
                  {t("auth.bootstrap.password")}
                </label>
                <input
                  id="bootstrap-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-11 rounded-[10px] border border-line bg-soft px-3 text-ink outline-none focus:border-accent"
                />
              </div>
              <button
                type="submit"
                className="h-11 rounded-[11px] border border-line text-ink transition hover:border-accent"
              >
                {t("auth.bootstrap.submit")}
              </button>
              {bootstrapError && (
                <p className="text-sm text-[#F26565]">{t("auth.bootstrap.error")}</p>
              )}
              <p className="text-xs text-muted">{t("auth.bootstrap.hint")}</p>
            </form>
          </>
        )}
        {mode && mode.bootstrapMode !== true && (
          <p className="rounded-[10px] bg-soft p-3 text-center text-sm text-muted">
            {t("auth.recoveryNotice")}
          </p>
        )}
      </div>
      <p className="text-[11.5px] tracking-[0.14em] text-muted">
        <span className="font-bold text-accent">CÉFIRO</span> · {t("app.tagline")}
      </p>
    </main>
  );
```

Add the import: `import { CefiroLogo } from "../../app/ui/CefiroLogo";`

- [ ] **Step 5: Run the auth suites + full suite**

Run: `cd apps/web && bun run test -- src/features/auth/` — Expected: PASS (SSO text, bootstrap labels/ids, absence case, POST body, new notice).
Run: `cd apps/web && bun run test` — Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/auth/LoginPage.tsx apps/web/src/features/auth/login-bootstrap.test.tsx apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json
git commit -m "feat(web): cefiro login screen with recovery notice"
```

---

### Task 5: Verification sweep

**Files:** none expected.

- [ ] **Step 1:** `cd apps/web && bun run test` — PASS.
- [ ] **Step 2:** `cd apps/web && bun run typecheck` — clean.
- [ ] **Step 3:** `cd apps/web && bun run build` — build OK; confirm `dist/assets` has `space-grotesk` woff2 files and zero references to `fonts.googleapis.com`/`fonts.gstatic.com` anywhere in `dist` (grep the dist output).
- [ ] **Step 4:** `cd apps/server && bun run test` — PASS (untouched).
- [ ] **Step 5:** Report results; commit only if fixes were needed.
