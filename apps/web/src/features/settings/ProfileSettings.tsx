import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { UpdateProfileInput } from "@webmail/shared";
import { Avatar } from "../../app/ui/Avatar";
import { updateProfile } from "./api";
import { settingsErrorKey } from "./errors";
import { SettingsLoadError, SettingsLoading } from "./PanelStates";
import { PROFILE_QUERY_KEY, useProfile } from "./useProfile";

// Mirrors apps/web/src/features/composer/RichTextEditor.tsx's raster-only
// image validation and ~1 MiB cap, narrowed to the server's avatar allowlist
// (no gif — see packages/shared/src/api/profile.ts) so a client-accepted
// file is never rejected by the server.
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_AVATAR_BYTES = 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export function ProfileSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const profileQuery = useProfile();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // null sentinel = "not yet synced from the loaded profile"; distinguishes
  // from a legitimately empty display name once loaded.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarDirty, setAvatarDirty] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profileQuery.data && displayName === null) {
      setDisplayName(profileQuery.data.displayName);
      setEmail(profileQuery.data.email);
      setAvatarPreview(profileQuery.data.avatarDataUrl);
    }
  }, [profileQuery.data, displayName]);

  const saveMutation = useMutation({
    mutationFn: (input: UpdateProfileInput) => updateProfile(input),
    onSuccess: async (data) => {
      setDisplayName(data.displayName);
      setEmail(data.email);
      setAvatarPreview(data.avatarDataUrl);
      setAvatarDirty(false);
      setErrorKey(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
    onError: (error) => setErrorKey(settingsErrorKey(error)),
  });

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Always allow re-selecting the same file (browsers don't fire onChange
    // again otherwise since the input's value wouldn't have changed).
    input.value = "";
    if (!file) return;

    if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
      setImageError(t("settings.errors.imageInvalidType"));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setImageError(t("settings.errors.imageTooLarge"));
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setAvatarPreview(dataUrl);
      setAvatarDirty(true);
      setImageError(null);
      setSaved(false);
    } catch {
      setImageError(t("settings.errors.generic"));
    }
  }

  function handleRemovePhoto() {
    setAvatarPreview(null);
    setAvatarDirty(false);
    setImageError(null);
    setSaved(false);
    saveMutation.mutate({ avatar: null });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (displayName === null || !profileQuery.data) return;

    const input: UpdateProfileInput = {};
    if (displayName !== profileQuery.data.displayName) {
      input.displayName = displayName;
    }
    if (avatarDirty) {
      input.avatar = avatarPreview;
    }
    if (Object.keys(input).length === 0) return;

    setSaved(false);
    saveMutation.mutate(input);
  }

  // GH #272: propagate #250's loading/error language. A failed load used to
  // `return null`, leaving a blank panel with no sign of the failure and no
  // retry — the same silent gap #250 closed for the other settings panels.
  if (profileQuery.isError) {
    return (
      <SettingsLoadError error={profileQuery.error} onRetry={() => void profileQuery.refetch()} />
    );
  }

  if (displayName === null) {
    return <SettingsLoading />;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar name={displayName} email={email} imageUrl={avatarPreview} size={72} />
        <div className="flex flex-col items-start gap-2">
          <input
            ref={fileInputRef}
            type="file"
            name="avatar"
            accept={Array.from(ALLOWED_AVATAR_TYPES).join(",")}
            aria-label={t("settings.photo")}
            onChange={(event) => void handleFileSelected(event)}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
          >
            {t("settings.changePhoto")}
          </button>
          {avatarPreview && (
            <button
              type="button"
              onClick={handleRemovePhoto}
              className="text-sm text-muted underline"
            >
              {t("settings.removePhoto")}
            </button>
          )}
        </div>
      </div>

      {imageError && (
        <p role="alert" className="text-xs text-warn">
          {imageError}
        </p>
      )}

      <label htmlFor="profile-display-name" className="flex flex-col gap-1 text-sm">
        {t("settings.displayName")}
        <input
          id="profile-display-name"
          value={displayName}
          maxLength={80}
          onChange={(event) => {
            setDisplayName(event.target.value);
            setSaved(false);
          }}
          className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
        />
      </label>

      {errorKey && (
        <p role="alert" className="text-sm text-danger">
          {t(errorKey)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="self-start rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
        >
          {t("settings.save")}
        </button>
        {saved && <span className="text-sm text-accent-text">{t("settings.saved")}</span>}
      </div>
    </form>
  );
}
