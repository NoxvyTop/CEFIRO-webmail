import { useState, type ComponentType, type FormEvent } from "react";
import type { CustomLabel, Identity, Mailbox } from "@webmail/shared";
import { useTranslation } from "react-i18next";
import { ArchiveIcon, CloseIcon, InboxIcon, PlusIcon, SendIcon, StarIcon } from "../../app/ui/icons";
import { folderName, orderedMailboxes } from "../../app/ui/folders";
import {
  CUSTOM_LABEL_PALETTE, isLabelNameTaken, labelColor, labelDisplayName, mergeLabels, slugifyLabelName,
} from "../../app/ui/labels";

// Spec (docs/design/cefiro/README.md, Webmail Céfiro.dc.html:79-95): only the
// four primary rows carry an icon. Secondary folders (trash/junk/drafts)
// aren't in the hi-fi and stay text-only.
const FOLDER_ICONS: Partial<Record<string, ComponentType<{ size?: number }>>> = {
  inbox: InboxIcon,
  sent: SendIcon,
  archive: ArchiveIcon,
};

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailboxId: string | null;
  onSelectMailbox: (mailboxId: string) => void;
  starredSelected: boolean;
  onSelectStarred: () => void;
  groups: Identity[];
  selectedGroup: string | null;
  onSelectGroup: (address: string) => void;
  labels: string[];
  selectedLabel: string | null;
  onSelectLabel: (label: string) => void;
  onCompose: () => void;
  // CLARO-10: honest disabled state when there are no identities to compose
  // from (e.g. mailbox not linked yet) instead of a silent no-op click.
  composeDisabled?: boolean;
  // User-defined labels (stored in userPreferences) — always shown in the
  // taxonomy alongside the 4 canonical labels, like Gmail's custom labels.
  customLabels?: CustomLabel[];
  onCreateLabel?: (label: CustomLabel) => void;
  onDeleteLabel?: (slug: string) => void;
}

export function Sidebar({
  mailboxes, selectedMailboxId, onSelectMailbox, starredSelected, onSelectStarred,
  groups, selectedGroup, onSelectGroup, labels, selectedLabel, onSelectLabel, onCompose,
  composeDisabled = false, customLabels = [], onCreateLabel = () => {}, onDeleteLabel = () => {},
}: SidebarProps) {
  const { t } = useTranslation();
  const displayLabels = mergeLabels(labels, customLabels.map((custom) => custom.slug));
  const customLabelSlugs = new Set(customLabels.map((custom) => custom.slug.toLowerCase()));

  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(CUSTOM_LABEL_PALETTE[0]!);
  const [createError, setCreateError] = useState<string | null>(null);

  function openCreateForm() {
    setCreatingLabel(true);
    setNewLabelName("");
    setNewLabelColor(CUSTOM_LABEL_PALETTE[0]!);
    setCreateError(null);
  }

  function closeCreateForm() {
    setCreatingLabel(false);
    setCreateError(null);
  }

  function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const name = newLabelName.trim();
    const slug = slugifyLabelName(name);
    if (slug.length === 0) {
      setCreateError(t("mail.labelNameRequired"));
      return;
    }
    if (isLabelNameTaken(name, customLabels)) {
      setCreateError(t("mail.labelNameDuplicate"));
      return;
    }
    onCreateLabel({ slug, name, color: newLabelColor });
    closeCreateForm();
  }

  // Fixed nav order (docs/design/cefiro/README.md): Recibidos, Destacados,
  // Enviados, Archivados, then secondary folders grouped after. Destacados is
  // a filtered view rather than a mailbox, so it is spliced in right after
  // the inbox row instead of coming from `mailboxes`.
  const ordered = orderedMailboxes(mailboxes);
  const inboxIndex = ordered.findIndex((mailbox) => mailbox.role === "inbox");
  const beforeStarred = inboxIndex === -1 ? [] : ordered.slice(0, inboxIndex + 1);
  const afterStarred = inboxIndex === -1 ? ordered : ordered.slice(inboxIndex + 1);

  function renderMailboxRow(mailbox: Mailbox) {
    const selected = mailbox.id === selectedMailboxId;
    // Spec: the accent unread counter is only ever shown on Recibidos.
    const showUnreadBadge = mailbox.role === "inbox" && mailbox.unreadEmails > 0;
    const Icon = mailbox.role ? FOLDER_ICONS[mailbox.role] : undefined;
    return (
      <li key={mailbox.id}>
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelectMailbox(mailbox.id)}
          className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
        >
          {Icon && <Icon size={17} />}
          <span className="flex-1">{folderName(mailbox, t)}</span>
          {showUnreadBadge && (
            <span
              aria-label={t("mail.unread", { count: mailbox.unreadEmails })}
              className="text-xs font-bold text-accent-text"
            >
              {mailbox.unreadEmails}
            </span>
          )}
        </button>
      </li>
    );
  }

  return (
    <aside className="flex w-[230px] shrink-0 overflow-y-auto flex-col gap-4 border-r border-line p-3">
      <button
        type="button"
        onClick={onCompose}
        disabled={composeDisabled}
        title={composeDisabled ? t("composer.noIdentitiesHint") : undefined}
        aria-disabled={composeDisabled}
        className="flex h-11 items-center justify-center gap-2 rounded-[11px] bg-accent font-bold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 disabled:active:scale-100"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        {t("composer.title")}
      </button>
      <ul className="flex flex-col gap-1">
        {beforeStarred.map(renderMailboxRow)}
        <li>
          <button
            type="button"
            aria-current={starredSelected ? "true" : undefined}
            onClick={onSelectStarred}
            className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
          >
            <StarIcon size={17} />
            <span>{t("mail.starredView")}</span>
          </button>
        </li>
        {afterStarred.map(renderMailboxRow)}
      </ul>
      {/* CLARO-08/OSCURO-07: always render the ETIQUETAS rail — the 4 canonical
          spec labels scaffold the taxonomy even on a fresh mailbox with no
          keywords yet, with any real labels merged in after them. */}
      <nav aria-label={t("mail.labels")} className="text-sm">
        <p aria-hidden="true" className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
          {t("mail.labels")}
        </p>
        <ul className="flex flex-col gap-1">
          {displayLabels.map((label) => {
            const selected = label === selectedLabel;
            // Only labels backed by a stored custom-label definition get a
            // delete affordance — canonical labels are fixed, and arbitrary
            // "discovered" keywords (freeform JMAP keywords applied by some
            // other client, not created through this UI) have no definition
            // to delete.
            const isCustom = customLabelSlugs.has(label.toLowerCase());
            const customDisplayName = labelDisplayName(label, customLabels);
            return (
              <li key={label} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelectLabel(label)}
                  className="flex h-[34px] min-w-0 flex-1 items-center gap-[11px] truncate rounded-[9px] px-3 text-left text-[13.5px] hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
                >
                  <span
                    aria-hidden="true"
                    className="h-[9px] w-[9px] shrink-0 rounded-[3px]"
                    style={{ background: labelColor(label, customLabels) }}
                  />
                  {/* labelDisplayName swaps text for the few canonical labels
                      whose spec spelling needs a diacritic CSS can't add
                      (e.g. "diseno" -> "Diseño") and for custom labels (their
                      stored display name); the `label` value itself — used
                      for onSelectLabel/filtering, dedup and color lookup — is
                      untouched. `capitalize` handles plain casing for
                      everything else. */}
                  <span className="truncate capitalize">{customDisplayName}</span>
                </button>
                {isCustom && (
                  <button
                    type="button"
                    aria-label={t("mail.deleteLabel", { name: customDisplayName })}
                    onClick={() => onDeleteLabel(label)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-1 px-3">
          {!creatingLabel ? (
            <button
              type="button"
              onClick={openCreateForm}
              className="flex h-8 items-center gap-1.5 text-[12.5px] font-semibold text-muted hover:text-ink"
            >
              <PlusIcon size={13} />
              {t("mail.newLabel")}
            </button>
          ) : (
            <form onSubmit={handleCreateSubmit} className="flex flex-col gap-2 rounded-[10px] border border-line p-2.5">
              <input
                type="text"
                value={newLabelName}
                onChange={(event) => {
                  setNewLabelName(event.target.value);
                  setCreateError(null);
                }}
                placeholder={t("mail.labelNamePlaceholder")}
                aria-label={t("mail.labelNamePlaceholder")}
                autoFocus
                className="h-8 rounded-[8px] border border-line bg-transparent px-2 text-[13px] text-ink field-focus"
              />
              <div className="flex flex-wrap gap-1.5">
                {CUSTOM_LABEL_PALETTE.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={t("mail.chooseLabelColor", { hex })}
                    aria-pressed={newLabelColor === hex}
                    onClick={() => setNewLabelColor(hex)}
                    className={`h-5 w-5 shrink-0 rounded-full border-2 ${
                      newLabelColor === hex ? "border-accent" : "border-transparent"
                    }`}
                    style={{ background: hex }}
                  />
                ))}
              </div>
              {createError && (
                <p role="alert" className="text-[11.5px] text-warn">
                  {createError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex h-7 flex-1 items-center justify-center rounded-[8px] bg-accent text-[12.5px] font-semibold text-accent-ink"
                >
                  {t("mail.createLabel")}
                </button>
                <button
                  type="button"
                  onClick={closeCreateForm}
                  className="flex h-7 items-center justify-center rounded-[8px] px-2 text-[12.5px] text-muted hover:text-ink"
                >
                  {t("mail.cancelNewLabel")}
                </button>
              </div>
            </form>
          )}
        </div>
      </nav>
      {groups.length > 0 && (
        <nav aria-label={t("groups.title")} className="text-sm">
          <p aria-hidden="true" className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
            {t("groups.title")}
          </p>
          <ul className="flex flex-col gap-1">
            {groups.map((group) => {
              const selected = group.email === selectedGroup;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectGroup(group.email)}
                    className="flex h-[34px] w-full items-center justify-between truncate rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
                  >
                    <span className="truncate">{group.email}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </aside>
  );
}
