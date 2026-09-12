import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { AppNotification } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

// Slice AA Scope F — minimal header indicator: an unread-count badge and a
// small dropdown of recent notifications. Deliberately not a notification
// center (no filters, no infinite scroll, no per-type routing) — see this
// slice's own F4 scope limit.
export function NotificationBell() {
  const { t, direction } = useTranslation();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<AppNotification[] | null>(null);

  function loadUnreadCount() {
    apiFetch<{ count: number }>("/notifications/unread-count")
      .then((res) => setUnreadCount(res.count))
      .catch(() => {});
  }

  useEffect(() => {
    loadUnreadCount();
    const interval = setInterval(loadUnreadCount, 60_000);
    return () => clearInterval(interval);
  }, []);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      apiFetch<{ notifications: AppNotification[] }>("/notifications?limit=10")
        .then((res) => setItems(res.notifications))
        .catch(() => setItems([]));
    }
  }

  async function markRead(id: string) {
    await apiFetch(`/notifications/${id}/read`, { method: "PATCH" });
    setItems((prev) => (prev ? prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) : prev));
    loadUnreadCount();
  }

  async function markAllRead() {
    await apiFetch("/notifications/mark-all-read", { method: "POST" });
    setItems((prev) => (prev ? prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) : prev));
    setUnreadCount(0);
  }

  return (
    <div className="relative">
      <button
        onClick={toggleOpen}
        className="relative text-stone-400 hover:text-stone-700"
        aria-label={t("notificationBell.ariaLabel")}
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -left-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 z-10 mt-2 w-80 rounded-lg border border-stone-200 bg-white shadow-lg" dir={direction}>
          <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2">
            <span className="text-sm font-medium text-stone-700">{t("notificationBell.ariaLabel")}</span>
            <button onClick={markAllRead} className="text-xs text-primary hover:underline">
              {t("notificationBell.markAllRead")}
            </button>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items === null && <li className="p-3 text-center text-sm text-stone-400">{t("common.loading")}</li>}
            {items?.length === 0 && <li className="p-3 text-center text-sm text-stone-400">{t("notificationBell.emptyMessage")}</li>}
            {items?.map((n) => (
              <li
                key={n.id}
                onClick={() => !n.readAt && markRead(n.id)}
                className={`cursor-pointer border-b border-stone-50 px-3 py-2 text-sm last:border-0 hover:bg-stone-50 ${
                  n.readAt ? "text-stone-400" : "text-stone-700"
                }`}
              >
                <p className="font-medium">{n.title}</p>
                <p className="text-xs">{n.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
