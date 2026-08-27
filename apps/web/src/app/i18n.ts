import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";

// A key shaped like "<namespace>.errors.<code>" — the shape every screen uses
// to turn a server error code into a message. The namespace is captured so the
// fallback below can reach that namespace's own generic message rather than a
// single global one.
const ERROR_KEY_PATTERN = /^([a-z][\w-]*)\.errors\.[\w-]+$/i;

/**
 * Last line of defence for a translation key that resolves to nothing (GH
 * #215). Without it, i18next's default is to return the key itself, so a
 * server error code with no message behind it was rendered to the user as the
 * literal string `mail.errors.jmap_error`.
 *
 * Callers are expected to go through errorMessages.ts's errorMessageKey, which
 * resolves to the generic message up front; this catches whatever still slips
 * past — a new call site, or a namespace outside that helper's own set.
 *
 * Only `<namespace>.errors.<code>` keys are redirected. Any other missing key
 * keeps i18next's return-the-key behaviour, which is a loud, obvious defect in
 * a screen's own copy rather than an unmapped code from the wire — quietly
 * swapping in an unrelated "something went wrong" there would hide it.
 */
function resolveMissingKey(key: string): string {
  const namespace = ERROR_KEY_PATTERN.exec(key)?.[1];
  const fallbackKey = namespace ? `${namespace}.errors.generic` : null;

  if (import.meta.env.DEV) {
    console.warn(
      `[i18n] missing translation for "${key}"${fallbackKey ? ` — using "${fallbackKey}"` : ""}`,
    );
  }

  // fallbackKey !== key guards the one recursion this could cause: a namespace
  // whose OWN generic message is the missing one.
  if (fallbackKey && fallbackKey !== key && i18n.exists(fallbackKey)) {
    return i18n.t(fallbackKey);
  }
  return key;
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: "es",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  parseMissingKeyHandler: (key: string) => resolveMissingKey(key),
});

export default i18n;
