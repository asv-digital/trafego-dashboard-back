import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const WEBHOOK_TOKEN = process.env.KIRVANO_WEBHOOK_TOKEN || "";
const PRODUCT_ID = "d75c9f66-212d-41aa-b2e2-1fbf7adcf657";

// POST /api/webhooks/kirvano — receive sale events
router.post("/kirvano", async (req: Request, res: Response) => {
  // Validate token
  const token = req.headers["x-webhook-token"] || req.body?.token;
  if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const payload = req.body;
  console.log("[Webhook Kirvano]", JSON.stringify(payload).slice(0, 300));

  // Only process approved purchases
  const event = payload.event || payload.tipo_evento;
  const status = payload.status || payload.subscription_status;

  if (!isApprovedPurchase(event, status)) {
    res.json({ received: true, action: "ignored", reason: "not an approved purchase" });
    return;
  }

  // Extract sale data
  const productId = payload.product?.id || payload.produto?.id || payload.product_id;
  if (productId && productId !== PRODUCT_ID) {
    res.json({ received: true, action: "ignored", reason: "different product" });
    return;
  }

  const amount = parseFloat(payload.amount || payload.valor || payload.sale?.amount || "97");
  const saleDate = new Date(payload.created_at || payload.data_criacao || new Date());
  const customerEmail = payload.customer?.email || payload.comprador?.email || "unknown";
  const customerName = payload.customer?.name || payload.comprador?.nome || "";

  // Find or create a generic campaign for webhook sales
  let campaign = await prisma.campaign.findFirst({
    where: { name: { contains: "Remarketing" } },
  });

  if (!campaign) {
    campaign = await prisma.campaign.findFirst({ orderBy: { createdAt: "asc" } });
  }

  if (!campaign) {
    // Create a default campaign if none exists
    campaign = await prisma.campaign.create({
      data: {
        name: "Vendas Diretas",
        type: "Orgânico",
        dailyBudget: 0,
        startDate: saleDate,
        status: "Ativa",
      },
    });
  }

  // Check if we already have a metric entry for today + this campaign
  const todayStart = new Date(saleDate);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(saleDate);
  todayEnd.setHours(23, 59, 59, 999);

  const existing = await prisma.metricEntry.findFirst({
    where: {
      campaignId: campaign.id,
      date: { gte: todayStart, lte: todayEnd },
      observations: { contains: "[Webhook]" },
    },
  });

  if (existing) {
    // Increment sales on existing entry
    await prisma.metricEntry.update({
      where: { id: existing.id },
      data: {
        sales: existing.sales + 1,
        observations: `[Webhook] ${existing.sales + 1} vendas | última: ${customerEmail}`,
      },
    });
    console.log(`[Webhook] +1 venda (total: ${existing.sales + 1}) em ${campaign.name}`);
  } else {
    // Create new entry for today
    await prisma.metricEntry.create({
      data: {
        date: todayStart,
        campaignId: campaign.id,
        adSet: "Webhook Kirvano",
        investment: 0,
        impressions: 0,
        clicks: 0,
        sales: 1,
        observations: `[Webhook] 1 venda | ${customerName} (${customerEmail}) | R$${amount.toFixed(2)}`,
      },
    });
    console.log(`[Webhook] Nova venda registrada em ${campaign.name}: ${customerEmail}`);
  }

  res.json({ received: true, action: "sale_recorded" });
});

function isApprovedPurchase(event: string | undefined, status: string | undefined): boolean {
  const approvedEvents = [
    "purchase_approved",
    "compra_aprovada",
    "sale_approved",
    "approved",
    "APPROVED",
    "paid",
  ];
  const approvedStatuses = ["approved", "APPROVED", "paid", "completed"];

  if (event && approvedEvents.some((e) => event.toLowerCase().includes(e.toLowerCase()))) {
    return true;
  }
  if (status && approvedStatuses.some((s) => status.toLowerCase() === s.toLowerCase())) {
    return true;
  }
  return false;
}

export default router;
