import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const PRODUCT_PRICE = 97;
const NET_PER_SALE = 93.6;

// GET all metrics (with computed fields)
router.get("/", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = {};
  if (req.query.campaignId) where.campaignId = req.query.campaignId as string;

  const metrics = await prisma.metricEntry.findMany({
    where,
    include: { campaign: { select: { id: true, name: true } } },
    orderBy: { date: "desc" },
  });

  const enriched = metrics.map((m) => ({
    ...m,
    cpm: m.impressions > 0 ? (m.investment / m.impressions) * 1000 : null,
    cpc: m.clicks > 0 ? m.investment / m.clicks : null,
    ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null,
    cpa: m.sales > 0 ? m.investment / m.sales : null,
    roas: m.investment > 0 ? (m.sales * PRODUCT_PRICE) / m.investment : null,
    revenue: m.sales * NET_PER_SALE,
  }));

  res.json(enriched);
});

// POST create metric entry
router.post("/", async (req: Request, res: Response) => {
  const { date, campaignId, adSet, investment, impressions, clicks, sales, frequency, hookRate, observations } = req.body;

  const metric = await prisma.metricEntry.create({
    data: {
      date: new Date(date),
      campaignId,
      adSet,
      investment: parseFloat(investment),
      impressions: parseInt(impressions),
      clicks: parseInt(clicks),
      sales: parseInt(sales),
      frequency: frequency ? parseFloat(frequency) : null,
      hookRate: hookRate ? parseFloat(hookRate) : null,
      observations,
    },
    include: { campaign: { select: { id: true, name: true } } },
  });

  res.status(201).json(metric);
});

// DELETE metric entry
router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await prisma.metricEntry.delete({ where: { id } });
  res.status(204).send();
});

// GET overview/KPIs
router.get("/overview", async (_req: Request, res: Response) => {
  const metrics = await prisma.metricEntry.findMany();

  const totalInvestment = metrics.reduce((s, m) => s + m.investment, 0);
  const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
  const totalClicks = metrics.reduce((s, m) => s + m.clicks, 0);
  const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);
  const totalRevenue = totalSales * NET_PER_SALE;

  res.json({
    totalInvestment,
    totalRevenue,
    totalSales,
    totalClicks,
    totalImpressions,
    roas: totalInvestment > 0 ? totalRevenue / totalInvestment : 0,
    cpa: totalSales > 0 ? totalInvestment / totalSales : 0,
    conversionRate: totalClicks > 0 ? (totalSales / totalClicks) * 100 : 0,
  });
});

export default router;
