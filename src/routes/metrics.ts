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

// GET overview/KPIs (Melhoria 9: period + compare support)
router.get("/overview", async (req: Request, res: Response) => {
  const periodParam = (req.query.period as string) || "7d";
  const compare = req.query.compare as string | undefined;

  const periodDays = periodParam === "30d" ? 30 : periodParam === "14d" ? 14 : 7;

  const now = new Date();
  const currentStart = new Date(now);
  currentStart.setDate(currentStart.getDate() - periodDays);

  const computeOverview = (metrics: { investment: number; sales: number; clicks: number; impressions: number }[]) => {
    const totalInvestment = metrics.reduce((s, m) => s + m.investment, 0);
    const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
    const totalClicks = metrics.reduce((s, m) => s + m.clicks, 0);
    const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);
    const totalRevenue = totalSales * NET_PER_SALE;
    return {
      totalInvestment,
      totalRevenue,
      totalSales,
      totalClicks,
      totalImpressions,
      roas: totalInvestment > 0 ? totalRevenue / totalInvestment : 0,
      cpa: totalSales > 0 ? totalInvestment / totalSales : 0,
      conversionRate: totalClicks > 0 ? (totalSales / totalClicks) * 100 : 0,
    };
  };

  const currentMetrics = await prisma.metricEntry.findMany({
    where: { date: { gte: currentStart, lte: now } },
  });

  const current = computeOverview(currentMetrics);

  if (compare === "previous") {
    const previousEnd = new Date(currentStart);
    previousEnd.setDate(previousEnd.getDate() - 1);
    const previousStart = new Date(previousEnd);
    previousStart.setDate(previousStart.getDate() - periodDays);

    const previousMetrics = await prisma.metricEntry.findMany({
      where: { date: { gte: previousStart, lte: previousEnd } },
    });

    const previous = computeOverview(previousMetrics);

    const calcVariation = (curr: number, prev: number) =>
      prev !== 0 ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : curr > 0 ? 100 : 0;

    const variation = {
      totalInvestment: calcVariation(current.totalInvestment, previous.totalInvestment),
      totalRevenue: calcVariation(current.totalRevenue, previous.totalRevenue),
      totalSales: calcVariation(current.totalSales, previous.totalSales),
      totalClicks: calcVariation(current.totalClicks, previous.totalClicks),
      totalImpressions: calcVariation(current.totalImpressions, previous.totalImpressions),
      roas: calcVariation(current.roas, previous.roas),
      cpa: calcVariation(current.cpa, previous.cpa),
      conversionRate: calcVariation(current.conversionRate, previous.conversionRate),
    };

    res.json({ current, previous, variation });
  } else {
    res.json(current);
  }
});

// GET /score — Operation score 0-100 (Melhoria 10)
router.get("/score", async (req: Request, res: Response) => {
  const periodParam = (req.query.period as string) || "7d";
  const periodDays = periodParam === "30d" ? 30 : periodParam === "14d" ? 14 : 7;

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - periodDays);

  const metrics = await prisma.metricEntry.findMany({
    where: { date: { gte: start, lte: now } },
  });

  const totalInvestment = metrics.reduce((s, m) => s + m.investment, 0);
  const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
  const totalClicks = metrics.reduce((s, m) => s + m.clicks, 0);
  const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);

  const cpa = totalSales > 0 ? totalInvestment / totalSales : 999;
  const roas = totalInvestment > 0 ? (totalSales * PRODUCT_PRICE) / totalInvestment : 0;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  const freqValues = metrics.filter((m) => m.frequency != null).map((m) => m.frequency!);
  const avgFrequency = freqValues.length > 0 ? freqValues.reduce((s, v) => s + v, 0) / freqValues.length : 0;

  const hookValues = metrics.filter((m) => m.hookRate != null).map((m) => m.hookRate!);
  const avgHookRate = hookValues.length > 0 ? hookValues.reduce((s, v) => s + v, 0) / hookValues.length : 0;

  // Creative health: fetch creatives with CPA
  const creatives = await prisma.creative.findMany({
    where: { cpa: { not: null } },
  });
  const healthyCreatives = creatives.filter((c) => c.cpa! < 50).length;
  const creativeHealthPct = creatives.length > 0 ? (healthyCreatives / creatives.length) * 100 : 0;

  // Score calculations
  const cpaScore = cpa < 50 ? 100 : cpa < 70 ? 60 : cpa < 97 ? 30 : 0;
  const roasScore = roas > 2.5 ? 100 : roas > 2.0 ? 80 : roas > 1.4 ? 50 : roas > 1.0 ? 20 : 0;
  const ctrScore = ctr > 2.0 ? 100 : ctr > 1.5 ? 70 : ctr > 0.8 ? 40 : 0;
  const freqScore = avgFrequency < 2 ? 100 : avgFrequency < 3 ? 70 : avgFrequency < 5 ? 40 : 0;
  const hookScore = avgHookRate > 30 ? 100 : avgHookRate > 25 ? 70 : avgHookRate > 18 ? 40 : 0;
  const creativeScore = creativeHealthPct;

  const score = Math.round(
    cpaScore * 0.25 +
    roasScore * 0.25 +
    ctrScore * 0.10 +
    freqScore * 0.15 +
    hookScore * 0.10 +
    creativeScore * 0.15
  );

  let status: string;
  let color: string;
  if (score >= 80) { status = "Excelente"; color = "#50c878"; }
  else if (score >= 60) { status = "Bom"; color = "#5b9bd5"; }
  else if (score >= 40) { status = "Atenção"; color = "#f0c040"; }
  else { status = "Crítico"; color = "#e85040"; }

  const breakdown = [
    { metric: "CPA", value: parseFloat(cpa.toFixed(2)), score: cpaScore, weight: 0.25 },
    { metric: "ROAS", value: parseFloat(roas.toFixed(2)), score: roasScore, weight: 0.25 },
    { metric: "CTR", value: parseFloat(ctr.toFixed(2)), score: ctrScore, weight: 0.10 },
    { metric: "Frequência", value: parseFloat(avgFrequency.toFixed(2)), score: freqScore, weight: 0.15 },
    { metric: "Hook Rate", value: parseFloat(avgHookRate.toFixed(2)), score: hookScore, weight: 0.10 },
    { metric: "Saúde dos Criativos", value: parseFloat(creativeHealthPct.toFixed(1)), score: Math.round(creativeScore), weight: 0.15 },
  ];

  const summaryParts: string[] = [];
  if (cpaScore <= 30) summaryParts.push(`CPA alto (R$${cpa.toFixed(2)}), precisa otimizar`);
  if (roasScore <= 20) summaryParts.push(`ROAS baixo (${roas.toFixed(2)}x), receita não cobre investimento`);
  if (freqScore <= 40) summaryParts.push(`Frequência alta (${avgFrequency.toFixed(1)}), público saturado`);
  if (hookScore <= 40) summaryParts.push(`Hook Rate baixo (${avgHookRate.toFixed(1)}%), criativos não prendem`);
  if (creativeHealthPct < 50) summaryParts.push(`${(100 - creativeHealthPct).toFixed(0)}% dos criativos com CPA acima do ideal`);
  if (summaryParts.length === 0) summaryParts.push("Operação saudável, manter estratégia atual");

  res.json({ score, status, color, breakdown, summary: summaryParts.join(". ") + "." });
});

export default router;
