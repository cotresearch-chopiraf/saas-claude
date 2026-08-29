import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { MetricCard } from "../../ui/MetricCard";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { formatMoney, formatDate } from "../../lib/format";
import { getCashFlow } from "../../api/cashflow";
import type { CashFlowResult } from "../../api/types";
import { useProjectContext } from "../context";

// Cash Flow (UI-06) — the frontend for the existing, fully-tested
// server/src/routes/cashflow.ts. Every figure is computed exclusively by
// lib/cashflow.ts's calculateCashFlow(); this screen only displays what
// the API returns. Purely read-only for both roles (no requirePermission
// gate exists server-side, confirmed by cashflow.test.ts's RBAC suite) —
// no create/mutate control exists here. `undated.etc` and
// `projected.commitments` are Forecast's own figures reused verbatim
// server-side; EAC is deliberately never part of this response (see
// docs/MIDAD_CASHFLOW_MODEL.md) and is never displayed here either.
export function CashFlowSection() {
  const { projectId } = useProjectContext();
  const [cashFlow, setCashFlow] = useState<CashFlowResult | null>(null);
  const [asOfDateInput, setAsOfDateInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load(asOfDate?: string) {
    setError(null);
    setCashFlow(null);
    getCashFlow(projectId, asOfDate)
      .then(setCashFlow)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل التدفق النقدي"));
  }
  useEffect(() => load(), [projectId]);

  function onDateSubmit(e: FormEvent) {
    e.preventDefault();
    load(asOfDateInput || undefined);
  }

  if (error && !cashFlow) {
    return (
      <div className="space-y-6">
        <PageHeader title="التدفق النقدي" />
        <ErrorState message={error} onRetry={() => load(asOfDateInput || undefined)} />
      </div>
    );
  }
  if (!cashFlow) {
    return (
      <div className="space-y-6">
        <PageHeader title="التدفق النقدي" />
        <Skeleton rows={6} />
      </div>
    );
  }

  const netTone = cashFlow.projected.net >= 0 ? "success" : "danger";

  return (
    <div className="space-y-6">
      <PageHeader title="التدفق النقدي" subtitle={`بتاريخ ${formatDate(cashFlow.asOfDate)}`} />

      {error && (
        <div>
          <ErrorState message={error} />
        </div>
      )}

      {/* Read-only PIT control — re-queries the same endpoint for a past
          asOfDate; never a persisted record, never a mutation. */}
      <Card className="p-4">
        <form onSubmit={onDateSubmit} className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-stone-600">
            عرض التدفق النقدي كما في تاريخ
            <input
              type="date"
              value={asOfDateInput}
              onChange={(e) => setAsOfDateInput(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="mt-1 block rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <Button type="submit" size="sm" variant="secondary">
            تحديث
          </Button>
        </form>
      </Card>

      {cashFlow.excludedForeignCurrencyCommitmentIds.length > 0 && (
        <p className="text-sm text-warning-700">
          تم استبعاد {cashFlow.excludedForeignCurrencyCommitmentIds.length} التزام(ات) بعملة مختلفة عن عملة المشروع
          ({cashFlow.currency}) من الالتزامات التعاقدية — لم يتم جمعها كوحدة واحدة.
        </p>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-stone-600">فعلي (محقَّق)</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <MetricCard label="المبلغ المُحصَّل فعلياً" value={formatMoney(cashFlow.historical.cashReceived, cashFlow.currency)} />
          <MetricCard label="التكلفة المتكبَّدة فعلياً" value={formatMoney(cashFlow.historical.incurredCost, cashFlow.currency)} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-stone-600">متوقَّع (لم يتحقق بعد)</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="المستحقات المتوقعة (فواتير مرسلة غير مسددة)" value={formatMoney(cashFlow.projected.receivables, cashFlow.currency)} />
          <MetricCard label="التحصيل المتوقع من الشهادات المعتمدة" value={formatMoney(cashFlow.projected.certifiedExpectedCollection, cashFlow.currency)} />
          <MetricCard label="الالتزامات التعاقدية" value={formatMoney(cashFlow.projected.commitments, cashFlow.currency)} />
          <MetricCard
            label="صافي التدفق المتوقع"
            value={formatMoney(cashFlow.projected.net, cashFlow.currency)}
            tone={netTone}
            hint="المستحقات + التحصيل المتوقع − الالتزامات"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-stone-600">غير مؤرَّخ (لا يوجد آلية توقيت في النظام الحالي)</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard label="المتبقي لإنجاز العمل (ETC)" value={formatMoney(cashFlow.undated.etc, cashFlow.currency)} />
          <MetricCard label="الضمان المحتجز" value={formatMoney(cashFlow.undated.retentionToBeReleased, cashFlow.currency)} hint="لا يوجد تاريخ إفراج مسجَّل" />
          <MetricCard label="الدفعة المقدَّمة" value="غير مدعومة" hint={cashFlow.undated.advance.reason} />
        </div>
      </section>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-stone-600">افتراضات الحساب</h2>
        <dl className="space-y-2 text-xs text-stone-500">
          <div>
            <dt className="font-medium text-stone-600">طريقة التوقعات المستخدَمة</dt>
            <dd>{cashFlow.assumptions.forecastMethod}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-600">أساس القيمة المعتمَدة</dt>
            <dd>{cashFlow.assumptions.certifiedValueBasis}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-600">مطابقة الالتزامات مع المصروفات</dt>
            <dd>{cashFlow.assumptions.commitmentExpenseReconciliation}</dd>
          </div>
          <div>
            <dt className="font-medium text-stone-600">مطابقة الشهادات المعتمدة مع الفواتير</dt>
            <dd>{cashFlow.assumptions.ipcInvoiceReconciliation}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
