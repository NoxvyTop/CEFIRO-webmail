const LABEL_COLORS = ["#F26565", "#5B8DEF", "#E5A13D", "#34C79A"];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function labelColor(label: string): string {
  return LABEL_COLORS[hashString(label.toLowerCase()) % LABEL_COLORS.length]!;
}

export function labelBackground(label: string): string {
  const hex = labelColor(label);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

export function userLabels(keywords: Record<string, boolean>): string[] {
  return Object.keys(keywords)
    .filter((key) => keywords[key] && !key.startsWith("$"))
    .sort();
}
