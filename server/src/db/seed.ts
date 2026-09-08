import "dotenv/config";
import { db } from "./client.js";
import { companies, users, projects, budgetItems, expenses, tasks } from "./schema.js";
import { hashPassword } from "../lib/password.js";

// Phase 3.2 P0 remediation (LOGIN-001) — this script inserts a demo
// company/owner/project with a well-known, publicly-documented password
// (see README.md). That is fine for a local/dev database nobody else can
// reach, and never acceptable against a database that also holds real
// customer data. Same fail-closed-in-production convention already used
// by lib/mailer.ts and lib/storage/index.ts: an explicit, informed choice
// is always honored, a silent default is not — there is no
// "SEED_ALLOW_PRODUCTION" escape hatch here because, unlike email/storage
// providers, there is no legitimate production reason to ever run this.
function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "db:seed refuses to run with NODE_ENV=production — it creates a publicly-documented demo account " +
        "(see README.md) and must never be run against a database holding real customer data.",
    );
  }
}

async function main() {
  assertNotProduction();

  const [company] = await db
    .insert(companies)
    .values({ name: "مقاولات النخبة للترميم" })
    .returning();

  const [owner] = await db
    .insert(users)
    .values({
      companyId: company.id,
      email: "demo@contractor-os.test",
      passwordHash: await hashPassword("demo1234"),
      name: "سارة أحمد",
      role: "owner",
    })
    .returning();

  const [project] = await db
    .insert(projects)
    .values({
      companyId: company.id,
      name: "ترميم شقة العائلة السعيدة",
      clientName: "أحمد المصري",
      address: "شارع الملك فهد، الرياض",
      status: "active",
      budgetTotal: "45000",
      startDate: new Date().toISOString().slice(0, 10),
    })
    .returning();

  const [demolition, materials, labor] = await db
    .insert(budgetItems)
    .values([
      { projectId: project.id, category: "الهدم والتجهيز", plannedAmount: "5000" },
      { projectId: project.id, category: "مواد البناء والتشطيب", plannedAmount: "25000" },
      { projectId: project.id, category: "أجور العمالة", plannedAmount: "15000" },
    ])
    .returning();

  await db.insert(expenses).values([
    {
      projectId: project.id,
      budgetItemId: demolition.id,
      description: "استئجار حاوية نفايات + عمال هدم",
      amount: "4200",
      expenseDate: new Date().toISOString().slice(0, 10),
    },
    {
      projectId: project.id,
      budgetItemId: materials.id,
      description: "بلاط وسيراميك",
      amount: "9800",
      expenseDate: new Date().toISOString().slice(0, 10),
    },
  ]);

  await db.insert(tasks).values([
    { projectId: project.id, title: "إزالة الأرضية القديمة", assigneeName: "فريق الهدم", status: "done" },
    { projectId: project.id, title: "تمديد الكهرباء الجديد", assigneeName: "كهربائي محمد", status: "in_progress" },
    { projectId: project.id, title: "تركيب البلاط", assigneeName: "فريق التشطيب", status: "todo" },
  ]);

  console.log("Seed complete.");
  console.log("Login with: demo@contractor-os.test / demo1234");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
