import type { ReactNode } from "react";

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center text-stone-500">
      <p>{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
