import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// GET all campaigns with aggregated metrics
router.get("/", async (_req: Request, res: Response) => {
  const campaigns = await prisma.campaign.findMany({
    include: {
      metrics: { orderBy: { date: "desc" } },
      creatives: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const withAggregates = campaigns.map((c) => {
    const totalInvestment = c.metrics.reduce((s, m) => s + m.investment, 0);
    const totalSales = c.metrics.reduce((s, m) => s + m.sales, 0);
    const totalClicks = c.metrics.reduce((s, m) => s + m.clicks, 0);
    const totalImpressions = c.metrics.reduce((s, m) => s + m.impressions, 0);
    const revenue = totalSales * 93.6;

    return {
      ...c,
      totalInvestment,
      totalSales,
      totalClicks,
      totalImpressions,
      revenue,
      cpa: totalSales > 0 ? totalInvestment / totalSales : null,
      roas: totalInvestment > 0 ? revenue / totalInvestment : null,
      ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null,
    };
  });

  res.json(withAggregates);
});

// GET single campaign
router.get("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { metrics: { orderBy: { date: "desc" } }, creatives: true },
  });
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  res.json(campaign);
});

// POST create campaign
router.post("/", async (req: Request, res: Response) => {
  const { name, type, audience, dailyBudget, startDate, status } = req.body;
  const campaign = await prisma.campaign.create({
    data: {
      name,
      type,
      audience,
      dailyBudget: parseFloat(dailyBudget),
      startDate: new Date(startDate),
      status: status || "Ativa",
    },
  });
  res.status(201).json(campaign);
});

// PATCH update campaign (status, budget, etc)
router.patch("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const data: Record<string, unknown> = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.type !== undefined) data.type = req.body.type;
  if (req.body.audience !== undefined) data.audience = req.body.audience;
  if (req.body.dailyBudget !== undefined) data.dailyBudget = parseFloat(req.body.dailyBudget);
  if (req.body.startDate !== undefined) data.startDate = new Date(req.body.startDate);
  if (req.body.status !== undefined) data.status = req.body.status;

  const campaign = await prisma.campaign.update({
    where: { id },
    data,
  });
  res.json(campaign);
});

// DELETE campaign
router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await prisma.campaign.delete({ where: { id } });
  res.status(204).send();
});

export default router;
