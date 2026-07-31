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

type AvatarProps = {
  name: string | null;
  email: string;
  size?: number;
  tone?: "palette" | "accent";
  // Uploaded profile photo (data: URL from GET /api/profile). When present
  // (and non-null), it replaces the initials block entirely; when absent or
  // null, the existing initials fallback renders unchanged.
  imageUrl?: string | null;
};

// "accent" is a distinct visual role from the rotating sender palette: the
// header's own user avatar (spec: 36px circular, fixed accent background),
// not another entry in the deterministic per-sender color rotation.
export function Avatar({ name, email, size = 38, tone = "palette", imageUrl }: AvatarProps) {
  const isAccent = tone === "accent";

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        aria-hidden="true"
        // GH #205: when imageUrl is a URL (e.g. the admin list's avatar
        // endpoint) let the browser lazy-load and cache it; harmless for the
        // data: URLs still passed by the header/profile.
        loading="lazy"
        decoding="async"
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full ${
        isAccent ? "bg-accent font-bold text-accent-ink" : "font-semibold"
      }`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.37),
        ...(isAccent ? {} : { background: avatarColor(email), color: "#F4FBF8" }),
      }}
    >
      {initials(name, email)}
    </span>
  );
}
