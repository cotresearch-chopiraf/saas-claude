export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Company {
  id: string;
  name: string;
}

export type ProjectStatus = "active" | "on_hold" | "completed";

export interface Project {
  id: string;
  companyId: string;
  name: string;
  clientName: string | null;
  address: string | null;
  status: ProjectStatus;
  budgetTotal: string;
  startDate: string | null;
  createdAt: string;
}

export interface BudgetItem {
  id: string;
  projectId: string;
  category: string;
  plannedAmount: string;
  spent: number;
  createdAt: string;
}

export interface Expense {
  id: string;
  projectId: string;
  budgetItemId: string | null;
  description: string;
  amount: string;
  expenseDate: string;
  createdAt: string;
}

export interface BudgetSummary {
  items: BudgetItem[];
  expenses: Expense[];
  totals: { planned: number; spent: number; remaining: number };
}

export type TaskStatus = "todo" | "in_progress" | "done";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  assigneeName: string | null;
  dueDate: string | null;
  status: TaskStatus;
  createdAt: string;
}

export type ChangeOrderStatus = "pending" | "approved" | "rejected";

export interface ChangeOrder {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  amountDelta: string;
  status: ChangeOrderStatus;
  createdAt: string;
}

export interface DailyLog {
  id: string;
  projectId: string;
  note: string;
  logDate: string;
  createdAt: string;
}

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected";
export type DocumentLanguage = "ar" | "fr" | "en";

export interface Quote {
  id: string;
  companyId: string;
  quoteNumber: string | null;
  clientName: string;
  clientEmail: string | null;
  projectName: string;
  language: DocumentLanguage;
  status: QuoteStatus;
  publicToken: string;
  acceptedByName: string | null;
  acceptedAt: string | null;
  createdAt: string;
  subtotal: number;
}

export interface QuoteItem {
  id: string;
  quoteId: string;
  description: string;
  amount: string;
}

export interface PublicQuote {
  projectName: string;
  clientName: string;
  status: QuoteStatus;
  companyName: string;
  items: QuoteItem[];
  total: number;
}

export type CompanyRole = "owner" | "member";

export interface CompanyMember {
  id: string;
  name: string;
  email: string;
  role: CompanyRole;
  createdAt: string;
}

export interface CompanyInvite {
  id: string;
  email: string;
  role: CompanyRole;
  expiresAt: string;
  createdAt: string;
}

export interface CompanyFeatureFlags {
  invoicing: boolean;
}

export interface CompanySettings {
  name: string;
  logoPath: string | null;
  address: string | null;
  taxId: string | null;
  phone: string | null;
  defaultTaxRatePercent: string;
  featureFlags: CompanyFeatureFlags;
}

export type InvoiceStatus = "draft" | "sent" | "paid";

export interface Invoice {
  id: string;
  companyId: string;
  quoteId: string | null;
  invoiceNumber: string;
  clientName: string;
  clientAddress: string | null;
  clientTaxId: string | null;
  taxRatePercent: string;
  language: DocumentLanguage;
  status: InvoiceStatus;
  publicToken: string;
  issueDate: string;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  subtotal: number;
  taxAmount: number;
  total: number;
}
