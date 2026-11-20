import type { Theme } from "../hooks/useTheme";

/** The exact 44x24px sliding pill theme switch from the design files. */
export default function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="theme-switch"
      onClick={onToggle}
      aria-label="Toggle dark obsidian and light stone theme"
      title="Toggle theme"
    >
      <span className="theme-knob">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.35" />
          <path d="M8 2 A6 6 0 0 1 8 14 Z" fill="currentColor" />
        </svg>
      </span>
      <span className="hidden">{theme}</span>
    </button>
  );
}
