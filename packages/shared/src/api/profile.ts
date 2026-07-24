import { z } from "zod";

export const profileViewSchema = z.object({
  displayName: z.string(),
  email: z.string(),
  avatarDataUrl: z.string().nullable(),
});
export type ProfileView = z.infer<typeof profileViewSchema>;

// Mirrors apps/web/src/features/composer/RichTextEditor.tsx's raster-only
// allowlist (SVG deliberately excluded — it can embed <script>) and its
// ~1 MiB cap on the raw image bytes. Avatars don't need animation, so gif
// is intentionally left out here even though the composer accepts it.
const AVATAR_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/;
const AVATAR_MAX_BYTES = 1024 * 1024;

function decodedBase64Length(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatar: z
    .string()
    .nullable()
    .refine(
      (value) => {
        if (value === null) return true;
        const match = AVATAR_DATA_URL_PATTERN.exec(value);
        if (!match) return false;
        return decodedBase64Length(match[2]!) <= AVATAR_MAX_BYTES;
      },
      { message: "errors.invalid_avatar" },
    )
    .optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
