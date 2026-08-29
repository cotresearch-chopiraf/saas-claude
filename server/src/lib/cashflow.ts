import { roundMoney } from "./money.js";

// The one canonical Cash Flow projection calculation — see
// docs/MIDAD_CASHFLOW_MODEL.md for the full model. Like lib/forecast.ts,
// this function has no database access, no HTTP awareness, and no side
// effects: routes/cashflow.ts's entire job is collecting these inputs from
// their canonical sources (reusing routes/forecast.ts's own
// collectForecastInputs for the BAC/AC/committedCost/ETC pieces — never
// re-deriving them independently), then handing them here.
//
// This function never labels anything "cash received" or "cash paid"
// unless the caller already established real payment evidence when
// collecting the inputs (paidAt on an Invoice) — it only combines numbers
// it is given, under the names it is given them.

export interface CashFlowInputs {
  // Historical (evidenced) — already happened.
  cashReceived: number; // Σ paid invoices' totals, paidAt <= asOfDate
  incurredCost: number; // Σ expenses, expenseDate <= asOfDate — never "paid"

  // Projected — real evidence exists, but not yet realized.
  receivables: number; // Σ issued-but-unpaid invoices' totals
  certifiedExpectedCollection: number; // Σ certified IPCs' netCertified (gross minus withheld retention)
  commitments: number; // = Forecast's own committedCost, reused verbatim

  // Undated — no timing mechanism exists in the schema for either of these.
  etc: number; // = Forecast's own commitment-aware ETC, reused verbatim
  retentionToBeReleased: number; // Σ certified IPCs' retentionAmount — no release date exists anywhere
}

export interface CashFlowCalculation {
  historical: {
    cashReceived: number;
    incurredCost: number;
  };
  projected: {
    receivables: number;
    certifiedExpectedCollection: number;
    commitments: number;
    // (receivables + certifiedExpectedCollection) - commitments. Deliberately
    // scoped to the projected bucket only — historical (already-realized)
    // amounts are never blended into this figure, and undated amounts
    // (ETC, retention) are never netted in either, since doing so would
    // imply a timing precision this data model cannot support.
    net: number;
  };
  undated: {
    etc: number;
    retentionToBeReleased: number;
  };
}

export function calculateCashFlow(inputs: CashFlowInputs): CashFlowCalculation {
  const { cashReceived, incurredCost, receivables, certifiedExpectedCollection, commitments, etc, retentionToBeReleased } =
    inputs;

  const net = roundMoney(receivables + certifiedExpectedCollection - commitments);

  return {
    historical: { cashReceived, incurredCost },
    projected: { receivables, certifiedExpectedCollection, commitments, net },
    undated: { etc, retentionToBeReleased },
  };
}
