type CefiroLogoProps = { size?: number };

export function CefiroLogo({ size = 32 }: CefiroLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className="text-accent"
    >
      {/* transform-box:fill-box scopes the rotation to the circle's own bounding
          box (matches the hi-fi prototype) instead of the full 40x40 viewport,
          which is what keeps the rotation from showing a faint GPU-layer box. */}
      <g style={{ transformOrigin: "center", transformBox: "fill-box", animation: "logoSpin 28s linear infinite" }}>
        <circle
          cx="20"
          cy="20"
          r="18"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeDasharray="3.5 6.5"
          opacity="0.45"
        />
      </g>
      <path
        d="M9 15h13a3.6 3.6 0 1 0-3.6-6.3"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeDasharray="12 36"
        style={{ animation: "windFlow 3.4s linear infinite" }}
      />
      <path
        d="M7 21h19a3.6 3.6 0 1 1 3.6 6.3"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeDasharray="12 36"
        style={{ animation: "windFlow 3.4s linear infinite", animationDelay: "-1.1s" }}
      />
      <path
        d="M9 27h10"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeDasharray="10 38"
        style={{ animation: "windFlow 3.4s linear infinite", animationDelay: "-2.2s" }}
      />
      <circle
        cx="33"
        cy="8"
        r="1.6"
        fill="currentColor"
        stroke="none"
        style={{ transformOrigin: "center", transformBox: "fill-box", animation: "twinkle 2.4s ease-in-out infinite" }}
      />
    </svg>
  );
}
