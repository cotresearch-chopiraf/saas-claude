import { FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { ChangeOrder } from "../api/types";

const money = (n: number) =>
  (n >= 0 ? "+" : "") + n.toLocaleString("ar", { maximumFractionDigits: 0 }) + " $";

const statusLabel: Record<ChangeOrder["status"], string> = {
  pending: "بانتظار القرار",
  approved: "معتمد",
  rejected: "مرفوض",
};

const statusColor: Record<ChangeOrder["status"], string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-stone-200 text-stone-500",
};

export function ChangeOrdersPanel({ projectId }: { projectId: string }) {
  const [orders, setOrders] = useState<ChangeOrder[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amountDelta, setAmountDelta] = useState("");

  function load() {
    apiFetch<ChangeOrder[]>(`/projects/${projectId}/change-orders`).then(setOrders);
  }

  useEffect(load, [projectId]);

  async function addOrder(e: FormEvent) {
    e.preventDefault();
    await apiFetch(`/projects/${projectId}/change-orders`, {
      method: "POST",
      body: JSON.stringify({ title, description: description || undefined, amountDelta }),
    });
    setTitle("");
    setDescription("");
    setAmountDelta("");
    load();
  }

  async function decide(order: ChangeOrder, status: "approved" | "rejected") {
    await apiFetch(`/projects/${projectId}/change-orders/${order.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    load();
  }

  return (
    <div>
      <p className="mb-3 text-sm text-stone-500">
        عند اعتماد أمر تغيير، يُضاف مبلغه تلقائياً إلى ميزانية المشروع الإجمالية.
      </p>
      <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
        {orders.map((order) => (
          <li key={order.id} className="flex items-center justify-between gap-3 p-3">
            <div>
              <p className="text-stone-800">{order.title}</p>
              {order.description && <p className="text-xs text-stone-500">{order.description}</p>}
              <p className={`text-sm font-medium ${Number(order.amountDelta) < 0 ? "text-emerald-600" : "text-stone-700"}`}>
                {money(Number(order.amountDelta))}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {order.status === "pending" ? (
                <>
                  <button
                    onClick={() => decide(order, "approved")}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white"
                  >
                    اعتماد
                  </button>
                  <button
                    onClick={() => decide(order, "rejected")}
                    className="rounded-md border border-stone-300 px-3 py-1 text-xs text-stone-600"
                  >
                    رفض
                  </button>
                </>
              ) : (
                <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor[order.status]}`}>
                  {statusLabel[order.status]}
                </span>
              )}
            </div>
          </li>
        ))}
        {orders.length === 0 && <li className="p-4 text-center text-stone-400">لا توجد أوامر تغيير بعد</li>}
      </ul>

      <form onSubmit={addOrder} className="mt-3 flex flex-wrap gap-2">
        <input
          required
          placeholder="عنوان أمر التغيير (مثال: تغيير نوع البلاط)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="تفاصيل إضافية (اختياري)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          placeholder="أثر المبلغ ($, سالب للخصم)"
          value={amountDelta}
          onChange={(e) => setAmountDelta(e.target.value)}
          className="w-56 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">إضافة أمر تغيير</button>
      </form>
    </div>
  );
}
