import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { budgetRouter } from "./routes/budget.js";
import { tasksRouter } from "./routes/tasks.js";
import { changeOrdersRouter } from "./routes/changeOrders.js";
import { dailyLogsRouter } from "./routes/dailyLogs.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/projects", requireAuth, projectsRouter);
app.use("/api/projects/:projectId/budget", requireAuth, budgetRouter);
app.use("/api/projects/:projectId/tasks", requireAuth, tasksRouter);
app.use("/api/projects/:projectId/change-orders", requireAuth, changeOrdersRouter);
app.use("/api/projects/:projectId/daily-logs", requireAuth, dailyLogsRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "حدث خطأ غير متوقع في الخادم" });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`contractor-os API listening on http://localhost:${port}`);
});
