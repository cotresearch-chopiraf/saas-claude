export interface TabItem {
  key: string;
  label: string;
}

// A generic, contextual tab strip (distinct from the project workspace's
// URL-based section navigation in project/ProjectSidebar.tsx) — for later
// in-page drill-down UX, e.g. a BOQ revision's "Items" vs "History"
// sub-view. Kept local-state-controlled by design: a contextual tab is
// scoped to whatever it's embedded in, not a bookmarkable destination on
// its own.
export function Tabs({ items, active, onChange }: { items: TabItem[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="flex gap-1 border-b border-stone-200" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          role="tab"
          aria-selected={active === item.key}
          onClick={() => onChange(item.key)}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
            active === item.key ? "border-primary text-primary" : "border-transparent text-stone-500 hover:text-stone-700"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
