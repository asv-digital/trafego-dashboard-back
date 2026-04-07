import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// POST /config — Save notification configuration
router.post("/config", async (req: Request, res: Response) => {
  const config = req.body;

  if (!config || typeof config !== "object") {
    res.status(400).json({ error: "Config JSON obrigatório." });
    return;
  }

  // Upsert: if any config exists, update the latest; otherwise create
  const existing = await prisma.notificationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  let record;
  if (existing) {
    record = await prisma.notificationConfig.update({
      where: { id: existing.id },
      data: { config },
    });
  } else {
    record = await prisma.notificationConfig.create({
      data: { config },
    });
  }

  res.json(record);
});

// GET /config — Get current notification config
router.get("/config", async (_req: Request, res: Response) => {
  const record = await prisma.notificationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (!record) {
    res.json({ config: null, message: "Nenhuma configuração de notificação encontrada." });
    return;
  }

  res.json(record);
});

// GET /log — List notification logs (last 50)
router.get("/log", async (_req: Request, res: Response) => {
  const logs = await prisma.notificationLog.findMany({
    orderBy: { sentAt: "desc" },
    take: 50,
  });

  res.json(logs);
});

// Helper function exported for use by scheduler
export async function sendNotification(rule: string, message: string, data?: any) {
  const configRecord = await prisma.notificationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });
  if (!configRecord) return;

  const config = configRecord.config as any;

  // Telegram
  const tg = config.channels?.telegram;
  if (tg?.enabled && tg?.bot_token && tg?.chat_id) {
    try {
      await fetch(`https://api.telegram.org/bot${tg.bot_token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: tg.chat_id,
          text: `🚨 TRÁFEGO\n\n${message}`,
          parse_mode: "Markdown",
        }),
      });
      await prisma.notificationLog.create({
        data: { rule, message, channel: "telegram", status: "sent" },
      });
    } catch {
      await prisma.notificationLog.create({
        data: { rule, message, channel: "telegram", status: "failed" },
      });
    }
  }

  // Generic webhook
  if (config.webhook_url) {
    try {
      await fetch(config.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rule,
          message,
          data,
          timestamp: new Date().toISOString(),
        }),
      });
      await prisma.notificationLog.create({
        data: { rule, message, channel: "webhook", status: "sent" },
      });
    } catch {
      await prisma.notificationLog.create({
        data: { rule, message, channel: "webhook", status: "failed" },
      });
    }
  }
}

export default router;
