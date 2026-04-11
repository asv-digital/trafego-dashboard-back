import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { sendNotification } from "../services/whatsapp-notifier";

const router = Router();

// GET /config — Get current notification config
router.get("/config", async (_req: Request, res: Response) => {
  const record = await prisma.notificationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (!record) {
    res.json({
      whatsappProvider: "z-api",
      whatsappInstanceId: null,
      whatsappToken: null,
      whatsappPhone: null,
      enabled: true,
      notifyAutoActions: true,
      notifyCreativeActions: true,
      notifyLearningPhase: true,
      notifyAlerts: true,
      notifyDailySummary: true,
    });
    return;
  }

  // Never expose the full token to the frontend
  res.json({
    ...record,
    whatsappToken: record.whatsappToken ? "••••••" + record.whatsappToken.slice(-4) : null,
  });
});

// PUT /config — Update notification config
router.put("/config", async (req: Request, res: Response) => {
  const {
    whatsappProvider,
    whatsappInstanceId,
    whatsappToken,
    whatsappPhone,
    enabled,
    notifyAutoActions,
    notifyCreativeActions,
    notifyLearningPhase,
    notifyAlerts,
    notifyDailySummary,
  } = req.body;

  const existing = await prisma.notificationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  const data: any = {};
  if (whatsappProvider !== undefined) data.whatsappProvider = whatsappProvider;
  if (whatsappInstanceId !== undefined) data.whatsappInstanceId = whatsappInstanceId;
  // Only update token if it's a real value (not the masked one)
  if (whatsappToken !== undefined && !whatsappToken.startsWith("••")) data.whatsappToken = whatsappToken;
  if (whatsappPhone !== undefined) data.whatsappPhone = whatsappPhone;
  if (enabled !== undefined) data.enabled = enabled;
  if (notifyAutoActions !== undefined) data.notifyAutoActions = notifyAutoActions;
  if (notifyCreativeActions !== undefined) data.notifyCreativeActions = notifyCreativeActions;
  if (notifyLearningPhase !== undefined) data.notifyLearningPhase = notifyLearningPhase;
  if (notifyAlerts !== undefined) data.notifyAlerts = notifyAlerts;
  if (notifyDailySummary !== undefined) data.notifyDailySummary = notifyDailySummary;

  let record;
  if (existing) {
    record = await prisma.notificationConfig.update({
      where: { id: existing.id },
      data,
    });
  } else {
    record = await prisma.notificationConfig.create({ data });
  }

  res.json(record);
});

// GET /log — Notification history
router.get("/log", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 500);

  const logs = await prisma.notificationLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(logs);
});

// POST /test — Send test notification
router.post("/test", async (_req: Request, res: Response) => {
  const success = await sendNotification("test");
  res.json({
    success,
    message: success
      ? "Mensagem de teste enviada com sucesso!"
      : "Falha ao enviar mensagem de teste. Verifique as configurações.",
  });
});

// GET /health — Saúde do canal de notificação.
// Polado pelo frontend a cada 60s. Se "degraded" ou "critical", o dashboard
// mostra um banner vermelho fixo no topo — garante visibilidade do problema
// mesmo se o próprio WhatsApp estiver quebrado.
router.get("/health", async (_req: Request, res: Response) => {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [lastSuccess, recentLogs] = await Promise.all([
    prisma.notificationLog.findFirst({
      where: { status: "sent" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.notificationLog.findMany({
      where: { createdAt: { gte: twentyFourHoursAgo } },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true, type: true },
    }),
  ]);

  const sentLast24h = recentLogs.filter((l) => l.status === "sent").length;
  const failedLast24h = recentLogs.filter((l) => l.status === "failed").length;

  // Streak de falhas consecutivas desde a última tentativa (ordenado desc).
  let consecutiveFailures = 0;
  for (const log of recentLogs) {
    if (log.status === "failed") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  const hoursSinceLastSuccess = lastSuccess
    ? (now.getTime() - lastSuccess.createdAt.getTime()) / (1000 * 60 * 60)
    : null;

  // Regras de status:
  // - critical: 3+ falhas consecutivas OU nenhum sucesso em 12h (mesmo sem falhas recentes — canal mudo)
  // - warning: 1-2 falhas consecutivas OU nenhum sucesso em 6h
  // - healthy: caso contrário
  let status: "healthy" | "warning" | "critical";
  let reason: string;

  if (consecutiveFailures >= 3) {
    status = "critical";
    reason = `${consecutiveFailures} falhas consecutivas no envio`;
  } else if (hoursSinceLastSuccess !== null && hoursSinceLastSuccess > 12) {
    status = "critical";
    reason = `nenhuma notificação entregue há ${hoursSinceLastSuccess.toFixed(1)}h`;
  } else if (hoursSinceLastSuccess === null && recentLogs.length === 0) {
    // Sem histórico nenhum — pode ser sistema novo, não é alarme.
    status = "healthy";
    reason = "sem histórico de notificações ainda";
  } else if (consecutiveFailures >= 1) {
    status = "warning";
    reason = `${consecutiveFailures} falha(s) recente(s)`;
  } else if (hoursSinceLastSuccess !== null && hoursSinceLastSuccess > 6) {
    status = "warning";
    reason = `última entrega há ${hoursSinceLastSuccess.toFixed(1)}h`;
  } else {
    status = "healthy";
    reason = hoursSinceLastSuccess !== null
      ? `última entrega há ${hoursSinceLastSuccess.toFixed(1)}h`
      : "canal ativo";
  }

  res.json({
    status,
    reason,
    last_success_at: lastSuccess?.createdAt.toISOString() ?? null,
    hours_since_last_success: hoursSinceLastSuccess !== null ? parseFloat(hoursSinceLastSuccess.toFixed(2)) : null,
    sent_last_24h: sentLast24h,
    failed_last_24h: failedLast24h,
    consecutive_failures: consecutiveFailures,
  });
});

export default router;
