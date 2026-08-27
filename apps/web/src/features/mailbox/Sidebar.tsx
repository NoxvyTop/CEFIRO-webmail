import { useEffect, useRef, useState, type ComponentType } from "react";
import type { CustomLabel, Identity, Mailbox } from "@webmail/shared";
import { useTranslation } from "react-i18next";
import { ArchiveIcon, CloseIcon, InboxIcon, PlusIcon, SendIcon, StarIcon, UsersIcon } from "../../app/ui/icons";
import { folderName, orderedMailboxes } from "../../app/ui/folders";
import { labelColor, labelDisplayName, mergeLabels } from "../../app/ui/labels";
import { useFocusTrap } from "../../app/ui/useFocusTrap";
import { NewLabelModal } from "./NewLabelModal";

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
  // GH #13/#50 (G-4): opens the "Buzones compartidos" page. Kept as a callback
  // (the parent owns the route navigation) so the Sidebar stays presentational,
  // like every other nav item here.
  onOpenSharedMailboxes?: () => void;
  // CLARO-10: honest disabled state when there are no identities to compose
  // from (e.g. mailbox not linked yet) instead of a silent no-op click.
  composeDisabled?: boolean;
  // User-defined labels (stored in userPreferences) — GH #102/#83: this is
  // now the entire taxonomy (no more seeded canonical scaffold), always
  // shown even with zero matching mail, like Gmail's custom labels.
  customLabels?: CustomLabel[];
  onCreateLabel?: (label: CustomLabel) => void;
  onDeleteLabel?: (slug: string) => void;
  // GH #177: on viewports below `lg` the sidebar collapses into an off-canvas
  // drawer (see MailPage) — `open` toggles it and `onClose` dismisses it. At
  // `lg`+ the drawer chrome is inert: the aside is a static column again and
  // `open` stays false (its only trigger, the hamburger, is `lg:hidden`).
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({
  mailboxes, selectedMailboxId, onSelectMailbox, starredSelected, onSelectStarred,
  groups, selectedGroup, onSelectGroup, labels, selectedLabel, onSelectLabel, onCompose,
  onOpenSharedMailboxes = () => {},
  composeDisabled = false, customLabels = [], onCreateLabel = () => {}, onDeleteLabel = () => {},
  open = false, onClose = () => {},
}: SidebarProps) {
  const { t } = useTranslation();
  // GH #177: while open as a drawer, trap Tab within it and restore focus to
  // the hamburger on close (same hook the modals use). Inert when `open` is
  // false, i.e. the static `lg`+ sidebar never traps.
  const drawerRef = useFocusTrap<HTMLElement>(open);

  // Esc dismisses the drawer — the accessible escape hatch #177 asks for.
  // Registered only while open, so the static sidebar adds no global listener.
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // GH #177: picking a destination closes the drawer so the mail list it
  // uncovers is immediately usable on narrow screens. Harmless at `lg`+ where
  // the drawer is never open (onClose just re-sets an already-false flag).
  function closeAfter<A extends unknown[]>(action: (...args: A) => void) {
    return (...args: A) => {
      action(...args);
      onClose();
    };
  }
  const selectMailbox = closeAfter(onSelectMailbox);
  const selectStarred = closeAfter(onSelectStarred);
  const selectGroup = closeAfter(onSelectGroup);
  const selectLabel = closeAfter(onSelectLabel);
  const compose = closeAfter(onCompose);
  const openSharedMailboxes = closeAfter(onOpenSharedMailboxes);
  const displayLabels = mergeLabels(labels, customLabels.map((custom) => custom.slug));
  const customLabelSlugs = new Set(customLabels.map((custom) => custom.slug.toLowerCase()));

  // GH #109: "Nueva etiqueta" opens a centered modal (NewLabelModal) instead
  // of an inline form — this flag just toggles the modal's mount state.
  const [creatingLabel, setCreatingLabel] = useState(false);
  // GH #103: a single click on the delete "x" must never delete outright —
  // it switches that one row into an inline confirm prompt instead. Tracking
  // just the slug (not a per-row boolean map) keeps at most one row in the
  // confirming state at a time, which is all the UI needs.
  const [confirmingDeleteSlug, setConfirmingDeleteSlug] = useState<string | null>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);

  // Review finding #2: without this, focus falls back to document.body when
  // a row swaps into the confirm prompt, stranding a keyboard user who just
  // activated delete via Enter/Space. Cancelar (not Confirmar) is the
  // auto-focus target — it's the safe action, so a reflexive second
  // Enter/Space (muscle memory from the keypress that opened the prompt)
  // cancels instead of deleting.
  useEffect(() => {
    if (confirmingDeleteSlug !== null) {
      cancelDeleteButtonRef.current?.focus();
    }
  }, [confirmingDeleteSlug]);

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
          onClick={() => selectMailbox(mailbox.id)}
          className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
        >
          {Icon && <Icon size={17} />}
          <span className="flex-1">{folderName(mailbox, t)}</span>
          {/* GH #253: same defect as MessageList's conversation counter — a
              plain <span> has the `generic` role, which supports no accessible
              name, so this `aria-label` never reached anyone and the badge was
              read out as a bare "5" glued to the folder name. The digit is
              hidden from assistive tech and the counted sentence rendered
              beside it. */}
          {showUnreadBadge && (
            <span className="text-xs font-bold text-accent-text">
              <span aria-hidden="true">{mailbox.unreadEmails}</span>
              <span className="sr-only">{t("mail.unread", { count: mailbox.unreadEmails })}</span>
            </span>
          )}
        </button>
      </li>
    );
  }

  return (
    <>
      {/* GH #177: dim + click-to-dismiss backdrop, drawer only (never at `lg`+
          where the sidebar is a static column). */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-overlay lg:hidden"
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <aside
        ref={drawerRef}
        id="mailbox-nav"
        tabIndex={-1}
        // Only a modal dialog while acting as an open drawer; at `lg`+ it's a
        // plain complementary landmark, so the dialog semantics (and the
        // shortcuts.ts MODAL_SELECTOR that suppresses j/k/etc.) apply solely
        // when it genuinely overlays the content.
        {...(open ? { role: "dialog", "aria-modal": true, "aria-label": t("mail.navRegion") } : {})}
        className={`${
          open ? "fixed inset-y-0 left-0 z-40 flex shadow-pop" : "hidden"
        } w-[230px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-panel p-3 outline-none lg:static lg:z-auto lg:flex lg:shadow-none`}
      >
        {/* Drawer-only close affordance; redundant chrome at `lg`+, so hidden there. */}
        <div className="flex justify-end lg:hidden">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("mail.closeNav")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </div>
      <button
        type="button"
        onClick={compose}
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
            onClick={selectStarred}
            className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
          >
            <StarIcon size={17} />
            <span>{t("mail.starredView")}</span>
          </button>
        </li>
        {afterStarred.map(renderMailboxRow)}
      </ul>
      {/* GH #13/#50 (G-4): shared mailboxes get their own page (reached here),
          not a header selector. Its own row after the folder list, split off by
          a hairline divider so it reads as a separate destination rather than
          another folder. Always shown — the page itself handles the common case
          of a member with no shared mailboxes with a friendly empty state. */}
      <div className="border-t border-line pt-3">
        <button
          type="button"
          onClick={openSharedMailboxes}
          className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover"
        >
          <UsersIcon size={17} />
          <span>{t("sharedMailboxes.title")}</span>
        </button>
      </div>
      {/* GH #102/#83: the ETIQUETAS rail always renders, but no longer
          scaffolds any canonical labels — it's empty on a fresh mailbox
          until the user creates their own or real keywords are discovered
          in loaded mail. */}
      <nav aria-label={t("mail.labels")} className="text-sm">
        <p aria-hidden="true" className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
          {t("mail.labels")}
        </p>
        <ul className="flex flex-col gap-1">
          {displayLabels.map((label) => {
            const selected = label === selectedLabel;
            // Only labels backed by a stored custom-label definition get a
            // delete affordance — a "discovered" keyword (a freeform JMAP
            // keyword applied by some other client, not created through this
            // UI) has no stored definition to delete.
            const isCustom = customLabelSlugs.has(label.toLowerCase());
            const customDisplayName = labelDisplayName(label, customLabels);
            const isConfirmingDelete = isCustom && confirmingDeleteSlug === label;
            return (
              <li key={label} className="group flex items-center gap-1">
                {isConfirmingDelete ? (
                  // GH #103: replaces the row with an inline confirm instead
                  // of deleting on the first click — onDeleteLabel only fires
                  // from the Confirmar button below.
                  <div className="flex h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-[9px] px-3 text-[13px]">
                    <span className="min-w-0 flex-1 truncate text-warn">
                      {t("mail.confirmDeleteLabel", { name: customDisplayName })}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onDeleteLabel(label);
                        setConfirmingDeleteSlug(null);
                      }}
                      className="flex h-6 shrink-0 items-center justify-center rounded-md px-2 text-[12px] font-semibold text-warn hover:bg-hover"
                    >
                      {t("mail.confirmDelete")}
                    </button>
                    <button
                      type="button"
                      ref={cancelDeleteButtonRef}
                      onClick={() => setConfirmingDeleteSlug(null)}
                      className="flex h-6 shrink-0 items-center justify-center rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-ink"
                    >
                      {t("mail.cancelNewLabel")}
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-current={selected ? "true" : undefined}
                      onClick={() => selectLabel(label)}
                      className="flex h-[34px] min-w-0 flex-1 items-center gap-[11px] truncate rounded-[9px] px-3 text-left text-[13.5px] hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
                    >
                      <span
                        aria-hidden="true"
                        className="h-[9px] w-[9px] shrink-0 rounded-[3px]"
                        style={{ background: labelColor(label, customLabels) }}
                      />
                      {/* labelDisplayName swaps text for the few labels whose
                          spec spelling needs a diacritic CSS can't add (e.g.
                          "diseno" -> "Diseño") and for custom labels (their
                          stored display name); the `label` value itself —
                          used for onSelectLabel/filtering, dedup and color
                          lookup — is untouched. `capitalize` handles plain
                          casing for everything else. */}
                      <span className="truncate capitalize">{customDisplayName}</span>
                    </button>
                    {isCustom && (
                      // GH #103: hidden by default (opacity-0, not removed —
                      // it stays in the tab order) and revealed on row
                      // hover/focus. group-focus-within + the button's own
                      // focus-visible cover keyboard users tabbing straight
                      // to it without hovering first.
                      <button
                        type="button"
                        aria-label={t("mail.deleteLabel", { name: customDisplayName })}
                        onClick={() => setConfirmingDeleteSlug(label)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                      >
                        <CloseIcon size={12} />
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-1 px-3">
          <button
            type="button"
            onClick={() => setCreatingLabel(true)}
            className="flex h-8 items-center gap-1.5 text-[12.5px] font-semibold text-muted hover:text-ink"
          >
            <PlusIcon size={13} />
            {t("mail.newLabel")}
          </button>
        </div>
      </nav>
      {creatingLabel && (
        <NewLabelModal
          customLabels={customLabels}
          onCreateLabel={onCreateLabel}
          onClose={() => setCreatingLabel(false)}
        />
      )}
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
                    onClick={() => selectGroup(group.email)}
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
    </>
  );
}
