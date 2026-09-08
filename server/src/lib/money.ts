// All monetary values in this app are 2-decimal-precision currency amounts.
// Summing and taxing them with raw JS float arithmetic does not reliably
// stay at 2 decimals (e.g. 0.1 + 0.2 !== 0.3) — every derived total in this
// codebase computes in integer cents and converts back only at the
// boundary, so the result is always exact to the cent regardless of input
// magnitude or how many fractional-cent line items are combined.

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function roundMoney(amount: number): number {
  return fromCents(toCents(amount));
}

export function sumMoney(amounts: number[]): number {
  return fromCents(amounts.reduce((cents, amount) => cents + toCents(amount), 0));
}

// Quantities in this app are 3-decimal-precision (numeric(14,3) in the
// schema — boqItems.quantity, ipcLines.currentQuantity, etc.). Same
// integer-arithmetic discipline as the cents helpers above, but at the
// milli-unit scale: a route that computes an amount from a raw input like
// 1.23456 and separately stores that same raw input would silently
// disagree with itself the moment Postgres rounds the stored column to
// 1.235 — round once, here, and use the SAME resulting number for both
// the stored quantity and any calculation derived from it.
export function toMilli(quantity: number): number {
  return Math.round(quantity * 1000);
}

export function fromMilli(milli: number): number {
  return milli / 1000;
}

export function roundQuantity(quantity: number): number {
  return fromMilli(toMilli(quantity));
}

export interface MoneyTotals {
  subtotal: number;
  taxAmount: number;
  total: number;
}

// Sums line-item amounts and applies a tax rate entirely in integer cents.
export function computeTotals(itemAmounts: number[], taxRatePercent: number): MoneyTotals {
  const subtotalCents = itemAmounts.reduce((cents, amount) => cents + toCents(amount), 0);
  const taxCents = Math.round(subtotalCents * (taxRatePercent / 100));
  const totalCents = subtotalCents + taxCents;
  return {
    subtotal: fromCents(subtotalCents),
    taxAmount: fromCents(taxCents),
    total: fromCents(totalCents),
  };
}
