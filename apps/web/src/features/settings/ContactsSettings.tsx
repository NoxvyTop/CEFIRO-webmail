import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Contact } from "@webmail/shared";
import { createContact, deleteContact, fetchContacts, promoteContact } from "../contacts/api";
import { HarvestedBadge } from "../contacts/HarvestedBadge";
import { settingsErrorKey } from "./errors";

const CONTACTS_QUERY_KEY = ["mail", "contacts"] as const;

// GH #124: address book — list, add and (irreversibly) delete contacts.
// Structured like ProfileSettings/VacationSettings: a query-backed list, a
// plain create form below it, mutation errors surfaced with role="alert"
// (see #148 — SignatureSettings does NOT do this and it's tracked as a bug;
// this section follows the correct precedent instead).
export function ContactsSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const contactsQuery = useQuery({ queryKey: CONTACTS_QUERY_KEY, queryFn: fetchContacts });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // Deleting is irreversible (the server tombstones the address so it can
  // never be re-harvested — see contacts/api.ts's deleteContact) — mirrors
  // Sidebar.tsx's inline two-step confirm for deleting a label (GH #103)
  // rather than deleting on the first click.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  function invalidateContacts() {
    return queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
  }

  const createMutation = useMutation({
    mutationFn: (input: { name: string; email: string }) => createContact(input),
    onSuccess: async () => {
      setName("");
      setEmail("");
      setErrorKey(null);
      await invalidateContacts();
    },
    onError: (error) => setErrorKey(settingsErrorKey(error)),
  });

  // GH #163: adopting a sender the harvest added on its own. Deliberately
  // single-click, unlike delete's two-step confirm above: deleting is
  // irreversible and tombstones the address, whereas this only clears an
  // advisory mark on a contact the user is already keeping. Guarding it behind
  // a confirmation would make the safe action feel as consequential as the
  // destructive one.
  const promoteMutation = useMutation({
    mutationFn: (id: string) => promoteContact(id),
    onSuccess: async () => {
      setErrorKey(null);
      await invalidateContacts();
    },
    onError: (error) => setErrorKey(settingsErrorKey(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteContact(id),
    onSuccess: async () => {
      setConfirmingDeleteId(null);
      setErrorKey(null);
      await invalidateContacts();
    },
    onError: (error) => setErrorKey(settingsErrorKey(error)),
  });

  if (!contactsQuery.data) {
    return null;
  }

  const contacts = contactsQuery.data;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;
    createMutation.mutate({ name: name.trim(), email: trimmedEmail });
  }

  function displayName(contact: Contact): string {
    return contact.name || contact.email;
  }

  return (
    <div className="flex flex-col gap-4">
      {errorKey && (
        <p role="alert" className="text-sm text-danger">
          {t(errorKey)}
        </p>
      )}

      {contacts.length === 0 ? (
        <p className="text-sm text-muted">{t("contacts.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((contact) => (
            <li
              key={contact.id}
              className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
            >
              {confirmingDeleteId === contact.id ? (
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <span className="flex-1 text-warn">
                    {t("contacts.confirmDeleteQuestion", { name: displayName(contact) })}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(contact.id)}
                    className="rounded-[9px] px-2 py-1 text-xs font-semibold text-warn transition hover:bg-hover"
                  >
                    {t("contacts.confirmDeleteAction")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteId(null)}
                    className="rounded-[9px] px-2 py-1 text-xs text-muted transition hover:bg-hover"
                  >
                    {t("contacts.cancelDelete")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{displayName(contact)}</span>
                      {contact.source === "harvested" && <HarvestedBadge withHint />}
                    </span>
                    {contact.name && <span className="truncate text-xs text-muted">{contact.email}</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {contact.source === "harvested" && (
                      // Named per contact rather than a bare "Confirmar": the
                      // list repeats this button, so a screen-reader user
                      // moving button to button would otherwise hear the same
                      // label on every row with nothing to tell them apart.
                      <button
                        type="button"
                        aria-label={t("contacts.promoteLabel", { name: displayName(contact) })}
                        onClick={() => promoteMutation.mutate(contact.id)}
                        className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
                      >
                        {t("contacts.promote")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(contact.id)}
                      className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
                    >
                      {t("settings.delete")}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label htmlFor="contact-name" className="flex flex-col gap-1 text-sm">
          {t("contacts.name")}
          <input
            id="contact-name"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
          />
        </label>

        <label htmlFor="contact-email" className="flex flex-col gap-1 text-sm">
          {t("contacts.email")}
          <input
            id="contact-email"
            type="email"
            value={email}
            maxLength={320}
            onChange={(event) => setEmail(event.target.value)}
            className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
          />
        </label>

        <button
          type="submit"
          className="self-start rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
        >
          {t("contacts.add")}
        </button>
      </form>
    </div>
  );
}
