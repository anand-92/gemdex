interface GemdexMarkProps {
  size?: number;
  className?: string;
}

/**
 * Product mark: a faceted gem whose lower half doubles as an index arrow —
 * "store it, find it again". Used instead of a stock icon for the brand.
 */
export function GemdexMark({ size = 16, className }: GemdexMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M12 2.5 20.5 8v8L12 21.5 3.5 16V8L12 2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 8 12 12.6 20.5 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M12 12.6v8.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="12" cy="12.6" r="1.6" fill="currentColor" />
    </svg>
  );
}
