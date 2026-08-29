export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 rounded-lg border border-stone-200 bg-white p-4" role="status" aria-label="جارٍ التحميل">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-stone-100" style={{ width: `${85 - i * 8}%` }} />
      ))}
    </div>
  );
}
