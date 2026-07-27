import type { ButtonHTMLAttributes } from "react";

// Variant taxonomy derived from this app's existing button patterns (GH
// #126) — not invented:
//   primary   — bg-accent + text-accent-ink (+ shadow-cta), the filled look
//               used by the composer's Send button, AdminPage.tsx's
//               primaryButtonClass and NewLabelModal.tsx's submit button.
//   secondary — a bordered/outlined look with a hover fill, used by
//               AdminPage.tsx's secondaryButtonClass, UserRow.tsx's
//               compactSecondaryButtonClass, and the composer's own
//               "Attach files" button.
// No destructive variant: nothing in the app renders a dedicated
// delete/danger BUTTON today — FilterSettings.tsx's danger-tinted "reapply"
// button is a retry action inside an error banner, not a destructive one —
// so one isn't invented here without real evidence it's needed.
export type ButtonVariant = "primary" | "secondary";

const VARIANT_CLASSNAMES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50",
  secondary:
    "border border-line-strong bg-panel text-ink transition hover:bg-hover disabled:opacity-50",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// Deliberately layout-agnostic: the variant classes above only carry color/
// interaction "chrome" (background, text color, border, hover/active/
// disabled states) — never height, padding, font-size, radius or gap. Every
// existing filled or outlined button in this codebase already sizes itself
// differently per context (compare the composer's Send button, AdminPage's
// primaryButtonClass and NewLabelModal's submit button: three different
// heights, paddings and radii for the same "primary" look), so baking one
// canonical size into this component would fight that established pattern.
// Callers supply sizing via `className`, appended after the variant
// classes; since the two sets never target the same CSS property, Tailwind's
// generated-stylesheet cascade order (which does not follow class-attribute
// order) can never create a conflicting override between them.
//
// No forwardRef: no component in this codebase forwards a ref today, and
// neither of this task's two call sites (the composer's discard and Send
// buttons) needs one — adding it here would be a pattern nobody uses yet.
export function Button({ variant = "secondary", type = "button", className, ...rest }: ButtonProps) {
  const classes = [VARIANT_CLASSNAMES[variant], className].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...rest} />;
}
