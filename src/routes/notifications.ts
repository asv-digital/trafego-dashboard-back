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

export default router;
