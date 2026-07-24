import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { EmailAddress } from "@webmail/shared";
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

export function RecipientField({ label, placeholder = label, value, onChange }: RecipientFieldProps) {
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
          aria-label={label}
          placeholder={value.length === 0 ? placeholder : undefined}
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={handleKeyDown}
          className="min-w-24 flex-1 border-none bg-transparent px-0.5 text-[14px] text-ink field-focus-line placeholder:text-muted"
        />
      </div>
      {invalid && <p className="text-[12.5px] text-danger">{t("composer.invalidEmail")}</p>}
    </div>
  );
}
