import express from "express";
import cors from "cors";
import prisma from "./prisma";
import campaignRoutes from "./routes/campaigns";
import metricRoutes from "./routes/metrics";
import creativeRoutes from "./routes/creatives";
import alertRoutes from "./routes/alerts";
import webhookRoutes from "./routes/webhooks";
import agentRoutes from "./routes/agent";
import metaActionsRoutes from "./routes/meta-actions";
import salesRoutes from "./routes/sales";
import placementMetricsRoutes from "./routes/placement-metrics";
import actionsRoutes from "./routes/actions";
import creativeLifecycleRoutes from "./routes/creative-lifecycle";
import briefingRoutes from "./routes/briefing";
import profitRoutes from "./routes/profit";
import goalsRoutes from "./routes/goals";
import notificationsRoutes from "./routes/notifications";
import testsRoutes from "./routes/tests";
import campaignBuilderRoutes from "./routes/campaign-builder";
import automationsRoutes from "./routes/automations";
import automationLocksRoutes from "./routes/automation-locks";
import commentsRoutes from "./routes/comments";
import audiencesRoutes from "./routes/audiences";
import reportsRoutes from "./routes/reports";
import adminRoutes from "./routes/admin";
import preflightRoutes from "./routes/preflight";
import { startScheduler } from "./agent/scheduler";
import { getAccountStatus } from "./lib/meta-account";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());

// Routes
app.use("/api/campaigns", campaignRoutes);
app.use("/api/metrics", metricRoutes);
app.use("/api/creatives", creativeRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/meta-actions", metaActionsRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/placement-metrics", placementMetricsRoutes);
app.use("/api/actions", actionsRoutes);
app.use("/api/creatives/lifecycle", creativeLifecycleRoutes);
app.use("/api/briefing", briefingRoutes);
app.use("/api/profit", profitRoutes);
app.use("/api/goals", goalsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/tests", testsRoutes);
app.use("/api/campaign-builder", campaignBuilderRoutes);
app.use("/api/automations", automationsRoutes);
app.use("/api/automations", automationLocksRoutes);
app.use("/api/comments", commentsRoutes);
app.use("/api/audiences", audiencesRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/agent/preflight", preflightRoutes);

// Health check (Melhoria 19)
app.get("/api/health", async (_req, res) => {
  const startTime = Date.now();
  const components: Record<string, any> = {};

  // Database check
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    components.database = { status: "ok", latency_ms: Date.now() - dbStart };
  } catch {
    components.database = { status: "error", latency_ms: -1 };
  }

  // Meta API check
  const metaToken = process.env.META_ACCESS_TOKEN || "";
  const metaCreatedAt = process.env.META_TOKEN_CREATED_AT;
  let tokenDaysRemaining = -1;
  if (metaCreatedAt) {
    const expires = new Date(metaCreatedAt);
    expires.setDate(expires.getDate() + 60);
    tokenDaysRemaining = Math.floor((expires.getTime() - Date.now()) / 86400000);
  }
  components.meta_api = {
    status: metaToken
      ? tokenDaysRemaining > 7
        ? "ok"
        : tokenDaysRemaining > 0
          ? "warning"
          : "error"
      : "not_configured",
    token_expires_in_days: tokenDaysRemaining,
  };

  // Meta ad account billing/status — canonical via Graph API (cached 60s)
  try {
    const accountStatus = await getAccountStatus();
    components.meta_account = {
      status: accountStatus.active ? "ok" : "critical",
      status_key: accountStatus.status_key,
      message: accountStatus.message,
      name: accountStatus.name,
    };
  } catch (err) {
    components.meta_account = { status: "error", error: (err as Error).message };
  }

  // Agent check
  components.agent = { status: "ok" };

  // Kirvano webhook — checa se env tá configurado (verdade canônica: o endpoint valida token)
  components.kirvano_webhook = {
    status: process.env.KIRVANO_WEBHOOK_TOKEN ? "ok" : "not_configured",
  };

  const overallStatus = Object.values(components).some((c: any) => c.status === "error")
    ? "critical"
    : Object.values(components).some((c: any) => c.status === "warning")
      ? "degraded"
      : "healthy";

  res.json({
    status: overallStatus,
    components,
    uptime_ms: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startScheduler();
});

export default app;
