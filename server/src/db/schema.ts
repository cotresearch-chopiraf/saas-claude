import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "on_hold",
  "completed",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "done",
]);

export const userRoleEnum = pgEnum("user_role", ["owner", "member"]);

export const changeOrderStatusEnum = pgEnum("change_order_status", [
  "pending",
  "approved",
  "rejected",
]);

export const quoteStatusEnum = pgEnum("quote_status", [
  "draft",
  "sent",
  "accepted",
  "rejected",
]);

// A company is the tenant boundary — every other table hangs off it,
// and every query in the app is scoped by companyId to keep tenants isolated.
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull().default("owner"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  clientName: text("client_name"),
  address: text("address"),
  status: projectStatusEnum("status").notNull().default("active"),
  budgetTotal: numeric("budget_total", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  startDate: date("start_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const budgetItems = pgTable("budget_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  plannedAmount: numeric("planned_amount", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  budgetItemId: uuid("budget_item_id").references(() => budgetItems.id, {
    onDelete: "set null",
  }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  expenseDate: date("expense_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  assigneeName: text("assignee_name"),
  dueDate: date("due_date"),
  status: taskStatusEnum("status").notNull().default("todo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Renovation scope changes constantly — this is the #1 workflow gap this
// product exists to close. Approving a change order shifts the project's
// budgetTotal by amountDelta (see the route handler).
export const changeOrders = pgTable("change_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  amountDelta: numeric("amount_delta", { precision: 12, scale: 2 }).notNull(),
  status: changeOrderStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// The single most-cited strength of the market leader (Buildertrend) is its
// site activity / daily log feature — this is the lightweight MVP version.
export const dailyLogs = pgTable("daily_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  logDate: date("log_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Reset flows never leak whether an email exists — the route always answers
// the same way. Only a hash of the token is stored, so a DB leak alone can't
// be used to take over an account; expiresAt caps the exposure window.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One company can have several users (owner + members) — an invite is how a
// second person joins an existing company instead of creating a new one.
export const companyInvites = pgTable("company_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A quote precedes a project — it's the estimate a contractor sends before
// work (and money) starts. publicToken lets the client view/accept it
// without an account, which is the whole point of a client-facing quote.
export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  projectName: text("project_name").notNull(),
  status: quoteStatusEnum("status").notNull().default("draft"),
  publicToken: text("public_token").notNull().unique(),
  acceptedByName: text("accepted_by_name"),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const quoteItems = pgTable("quote_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => quotes.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const companiesRelations = relations(companies, ({ many }) => ({
  users: many(users),
  projects: many(projects),
  invites: many(companyInvites),
  quotes: many(quotes),
}));

export const quotesRelations = relations(quotes, ({ one, many }) => ({
  company: one(companies, {
    fields: [quotes.companyId],
    references: [companies.id],
  }),
  items: many(quoteItems),
}));

export const quoteItemsRelations = relations(quoteItems, ({ one }) => ({
  quote: one(quotes, {
    fields: [quoteItems.quoteId],
    references: [quotes.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  company: one(companies, {
    fields: [projects.companyId],
    references: [companies.id],
  }),
  budgetItems: many(budgetItems),
  expenses: many(expenses),
  tasks: many(tasks),
  changeOrders: many(changeOrders),
  dailyLogs: many(dailyLogs),
}));

export const changeOrdersRelations = relations(changeOrders, ({ one }) => ({
  project: one(projects, {
    fields: [changeOrders.projectId],
    references: [projects.id],
  }),
}));

export const dailyLogsRelations = relations(dailyLogs, ({ one }) => ({
  project: one(projects, {
    fields: [dailyLogs.projectId],
    references: [projects.id],
  }),
}));

export const budgetItemsRelations = relations(budgetItems, ({ one, many }) => ({
  project: one(projects, {
    fields: [budgetItems.projectId],
    references: [projects.id],
  }),
  expenses: many(expenses),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  project: one(projects, {
    fields: [expenses.projectId],
    references: [projects.id],
  }),
  budgetItem: one(budgetItems, {
    fields: [expenses.budgetItemId],
    references: [budgetItems.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
}));
