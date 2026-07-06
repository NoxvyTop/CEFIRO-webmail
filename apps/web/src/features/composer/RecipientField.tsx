import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { EmailAddress } from "@webmail/shared";

interface RecipientFieldProps {
  label: string;
  value: EmailAddress[];
  onChange(value: EmailAddress[]): void;
}

function isValidEmailShape(candidate: string): boolean {
  const at = candidate.indexOf("@");
  return at > 0 && at < candidate.length - 1;
}

export function RecipientField({ label, value, onChange }: RecipientFieldProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState("");
  const [invalid, setInvalid] = useState(false);

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
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    }
  }

  function handleRemove(email: string) {
    onChange(value.filter((address) => address.email !== email));
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1 rounded-md border p-1">
        {value.map((address) => (
          <span
            key={address.email}
            className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs"
          >
            {address.name || address.email}
            <button
              type="button"
              aria-label={t("composer.removeRecipient", { email: address.email })}
              onClick={() => handleRemove(address.email)}
              className="text-gray-500"
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label={label}
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={handleKeyDown}
          className="min-w-24 flex-1 border-none text-sm outline-none"
        />
      </div>
      {invalid && <p className="text-xs text-amber-700">{t("composer.invalidEmail")}</p>}
    </div>
  );
}
