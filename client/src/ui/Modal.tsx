import { useEffect, type ReactNode } from "react";

// Minimal centered dialog: backdrop click and Escape both close it,
// focus/scroll are not fully trapped (no accessibility framework per
// UI-Foundation scope) but semantics are real (role="dialog",
// aria-modal). Used directly for simple confirmations (see
// ConfirmDialog.tsx) and as the base for the mobile project-navigation
// drawer (project/ProjectSidebar.tsx renders it edge-anchored via
// className rather than a separate Drawer component — one primitive,
// not two nearly-identical ones).
export function Modal({
  open,
  onClose,
  title,
  children,
  className = "mx-4 w-full max-w-md",
  align = "center",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  // "end" anchors the panel to the RTL end edge (visually the right — the
  // sidebar's own side) and stretches it full-height, giving a drawer-like
  // presentation from the same primitive as a plain centered confirmation
  // — see project/ProjectSidebar.tsx's mobile menu.
  align?: "center" | "end";
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const wrapperAlign = align === "end" ? "items-stretch justify-end" : "items-center justify-center";
  const panelShape = align === "end" ? "h-full overflow-y-auto rounded-none" : "rounded-lg";

  return (
    <div className={`fixed inset-0 z-50 flex ${wrapperAlign} bg-stone-900/40`} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white p-5 shadow-lg ${panelShape} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="mb-3 text-lg font-semibold text-stone-800">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
