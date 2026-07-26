import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Contact, EmailAddress } from "@webmail/shared";
import { searchContacts } from "../contacts/api";
import { CloseIcon } from "../../app/ui/icons";

interface RecipientFieldProps {
  label: string;
  placeholder?: string;
  value: EmailAddress[];
  onChange(value: EmailAddress[]): void;
}

function isValidEmailShape(candidate: string): boolean {
  const at = candidate.indexOf("@");
  return at > 0 && at < candidate.length - 1;
}

// GH #124: mirrors the server's own floor (apps/server/src/modules/contacts/router.ts,
// MIN_QUERY_LENGTH) — below it the endpoint just returns [], so there is
// nothing to gain by asking it every keystroke.
const MIN_QUERY_LENGTH = 2;

// Long enough to absorb normal typing cadence (so a request isn't fired per
// keystroke), short enough that the dropdown still feels responsive once the
// user pauses.
const SEARCH_DEBOUNCE_MS = 250;

function suggestionKey(email: string): string {
  return email.trim().toLowerCase();
}

export function RecipientField({ label, placeholder = label, value, onChange }: RecipientFieldProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slower, earlier request overwriting a faster, later one
  // once both resolve — only the response matching the most recently issued
  // request is ever applied.
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Suggestions already present as a recipient are never offered again.
  // Filtered live off the raw `suggestions` state (rather than at fetch
  // time) so removing/adding a chip while the dropdown is open updates it
  // immediately, without needing a fresh request.
  const addedEmails = new Set(value.map((address) => suggestionKey(address.email)));
  const visibleSuggestions = suggestions.filter(
    (contact) => !addedEmails.has(suggestionKey(contact.email)),
  );
  const showList = open && visibleSuggestions.length > 0;
  const clampedActiveIndex = Math.min(activeIndex, Math.max(visibleSuggestions.length - 1, 0));

  function closeSuggestions() {
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(0);
  }

  function scheduleSearch(rawQuery: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = rawQuery.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      // Cancels any pending request's effect on arrival too, via the id bump.
      requestIdRef.current += 1;
      closeSuggestions();
      return;
    }

    debounceRef.current = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      searchContacts(query)
        .then((results) => {
          if (requestIdRef.current !== requestId) return; // superseded by a later keystroke
          setSuggestions(results);
          setOpen(true);
          setActiveIndex(0);
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
          // A failed search must never block typing — just show nothing.
          closeSuggestions();
        });
    }, SEARCH_DEBOUNCE_MS);
  }

  function commit() {
    const candidate = inputValue.trim().replace(/,$/, "").trim();
    if (!candidate) return;
    if (!isValidEmailShape(candidate)) {
      setInvalid(true);
      return;
    }
    onChange([...value, { name: null, email: candidate }]);
    setInputValue("");
    setInvalid(false);
    closeSuggestions();
  }

  function selectSuggestion(contact: Contact) {
    onChange([...value, { name: contact.name || null, email: contact.email }]);
    setInputValue("");
    setInvalid(false);
    closeSuggestions();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (showList) {
        // Swallow it here — the composer owns a window-level Escape handler
        // (GH #125) that closes it (or opens the discard confirmation), and
        // without stopping propagation that handler would fire right along
        // with this one, closing the whole composer out from under the user
        // over what was meant to just dismiss the suggestion list.
        event.preventDefault();
        event.stopPropagation();
        closeSuggestions();
      }
      return;
    }

    if (showList && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(Math.max(current + delta, 0), visibleSuggestions.length - 1),
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (showList) {
        const highlighted = visibleSuggestions[clampedActiveIndex];
        if (highlighted) {
          selectSuggestion(highlighted);
          return;
        }
      }
      commit();
      return;
    }

    if (event.key === ",") {
      event.preventDefault();
      commit();
    }
  }

  function handleRemove(email: string) {
    onChange(value.filter((address) => address.email !== email));
  }

  const activeOptionId =
    showList && visibleSuggestions[clampedActiveIndex]
      ? `${listboxId}-option-${clampedActiveIndex}`
      : undefined;

  return (
    <div className="relative flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5 border-0 border-b border-line bg-transparent py-3 focus-within:border-accent">
        {value.map((address) => (
          <span
            key={address.email}
            className="flex items-center gap-1 rounded-full bg-sel px-2 py-0.5 text-xs"
          >
            {address.name || address.email}
            <button
              type="button"
              aria-label={t("composer.removeRecipient", { email: address.email })}
              onClick={() => handleRemove(address.email)}
              className="text-muted"
            >
              <CloseIcon size={12} />
            </button>
          </span>
        ))}
        <input
          role="combobox"
          aria-label={label}
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          placeholder={value.length === 0 ? placeholder : undefined}
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setInvalid(false);
            scheduleSearch(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onBlur={closeSuggestions}
          className="min-w-24 flex-1 border-none bg-transparent px-0.5 text-[14px] text-ink field-focus-line placeholder:text-muted"
        />
      </div>
      {invalid && <p className="text-[12.5px] text-danger">{t("composer.invalidEmail")}</p>}
      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          // Keeps focus on the input across a mouse click on an option — a
          // mousedown-triggered blur would otherwise close the list before
          // the click that should select from it ever fires.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full min-w-[220px] overflow-y-auto rounded-[12px] border border-line bg-panel py-1 shadow-pop"
        >
          {visibleSuggestions.map((contact, index) => (
            <li
              key={contact.id}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={index === clampedActiveIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectSuggestion(contact)}
              className={`flex cursor-pointer flex-col px-3 py-1.5 text-[13px] ${
                index === clampedActiveIndex ? "bg-sel" : ""
              }`}
            >
              <span className="truncate font-medium text-ink">{contact.name || contact.email}</span>
              {contact.name && <span className="truncate text-xs text-muted">{contact.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
