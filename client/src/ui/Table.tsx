import type { ReactNode } from "react";

// The bare structural shell every table in this app uses: a bordered,
// rounded, white surface with a horizontal-scroll container so a wide
// financial table (many columns) never breaks the page layout — it
// scrolls within its own box instead. RTL-safe by construction: it does
// not set any direction-specific margin/padding, it inherits dir from the
// document.
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className="w-full min-w-max text-sm">{children}</table>
    </div>
  );
}
