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
