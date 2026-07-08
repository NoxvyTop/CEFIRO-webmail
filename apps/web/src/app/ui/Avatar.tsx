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

type AvatarProps = { name: string | null; email: string; size?: number };

export function Avatar({ name, email, size = 38 }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: avatarColor(email),
        color: "#F4FBF8",
        fontSize: Math.round(size * 0.37),
      }}
    >
      {initials(name, email)}
    </span>
  );
}
