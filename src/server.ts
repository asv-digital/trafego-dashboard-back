import express from "express";
import cors from "cors";
import campaignRoutes from "./routes/campaigns";
import metricRoutes from "./routes/metrics";
import creativeRoutes from "./routes/creatives";
import alertRoutes from "./routes/alerts";
import webhookRoutes from "./routes/webhooks";
import agentRoutes from "./routes/agent";
import metaActionsRoutes from "./routes/meta-actions";
import salesRoutes from "./routes/sales";
import { startScheduler } from "./agent/scheduler";

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

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startScheduler();
});

export default app;
