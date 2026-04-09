import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const NET_PER_SALE = 93.6;
const KIRVANO_FEE_RATE = 0.035;

function formatBRL(v: number) {
  return `R$${v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatDate(d: Date) {
  return d.toLocaleDateString("pt-BR");
}

// POST /generate — Generate CEO report
router.post("/generate", async (req: Request, res: Response) => {
  const { period, start, end } = req.body;

  // Compute date range
  const now = new Date();
  let periodStart: Date;
  let periodEnd: Date = now;
  let periodLabel: string;

  if (period === "custom" && start && end) {
    periodStart = new Date(start);
    periodEnd = new Date(end);
    periodLabel = `${formatDate(periodStart)} a ${formatDate(periodEnd)}`;
  } else if (period === "month") {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    periodLabel = `${formatDate(periodStart)} a ${formatDate(periodEnd)}`;
  } else {
    const days = period === "30d" ? 30 : period === "14d" ? 14 : 7;
    periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() - days);
    periodLabel = `${formatDate(periodStart)} a ${formatDate(periodEnd)}`;
  }

  // Previous period (same length)
  const periodLengthMs = periodEnd.getTime() - periodStart.getTime();
  const prevEnd = new Date(periodStart.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - periodLengthMs);

  // Fetch current metrics
  const currentMetrics = await prisma.metricEntry.findMany({
    where: { date: { gte: periodStart, lte: periodEnd } },
    include: { campaign: { select: { id: true, name: true } } },
  });

  const prevMetrics = await prisma.metricEntry.findMany({
    where: { date: { gte: prevStart, lte: prevEnd } },
  });

  // Aggregate current
  const totalInvestment = currentMetrics.reduce((s, m) => s + m.investment, 0);
  const totalSales = currentMetrics.reduce((s, m) => s + m.sales, 0);
  const grossRevenue = totalSales * 97;
  const netRevenue = grossRevenue * (1 - KIRVANO_FEE_RATE);
  const profit = netRevenue - totalInvestment;
  const margin = netRevenue > 0 ? (profit / netRevenue) * 100 : 0;
  const cpa = totalSales > 0 ? totalInvestment / totalSales : 0;
  const roas = totalInvestment > 0 ? netRevenue / totalInvestment : 0;

  // Aggregate previous
  const prevInvestment = prevMetrics.reduce((s, m) => s + m.investment, 0);
  const prevSales = prevMetrics.reduce((s, m) => s + m.sales, 0);
  const prevNetRevenue = prevSales * 97 * (1 - KIRVANO_FEE_RATE);
  const prevProfit = prevNetRevenue - prevInvestment;
  const prevCpa = prevSales > 0 ? prevInvestment / prevSales : 0;

  function pctChange(curr: number, prev: number): string {
    if (prev === 0) return curr > 0 ? "+100%" : "0%";
    const change = ((curr - prev) / prev) * 100;
    return `${change >= 0 ? "+" : ""}${change.toFixed(0)}%`;
  }

  // Per-campaign performance
  const campaignMap = new Map<string, { name: string; spend: number; sales: number }>();
  for (const m of currentMetrics) {
    const key = m.campaignId;
    if (!campaignMap.has(key)) {
      campaignMap.set(key, { name: m.campaign?.name || "Desconhecida", spend: 0, sales: 0 });
    }
    const c = campaignMap.get(key)!;
    c.spend += m.investment;
    c.sales += m.sales;
  }

  const campaignPerf = [...campaignMap.values()].map((c) => ({
    name: c.name,
    cpa: c.sales > 0 ? Math.round(c.spend / c.sales) : 999,
    sales: c.sales,
  }));

  campaignPerf.sort((a, b) => a.cpa - b.cpa);
  const topPerformers = campaignPerf
    .filter((c) => c.sales > 0)
    .slice(0, 3)
    .map((c, i) => ({
      ...c,
      status: i === 0 ? "Melhor conjunto" : `#${i + 1} melhor`,
    }));
  const worstPerformers = campaignPerf
    .filter((c) => c.sales > 0 && c.cpa > 70)
    .slice(-3)
    .reverse()
    .map((c) => ({
      ...c,
      status: c.cpa > 93.6 ? "Acima do breakeven" : "Acima do limite",
    }));

  // LTV data
  const totalBuyers = await prisma.sale.count({ where: { status: "approved" } });
  const mentoriaConverted = await prisma.sale.count({ where: { convertedToMentoria: true } });
  const conversionRate = totalBuyers > 0 ? (mentoriaConverted / totalBuyers) * 100 : 0;
  const mentoriaRevenue = mentoriaConverted * 3000;
  const estimatedLtv =
    totalBuyers > 0 ? (totalBuyers * NET_PER_SALE + mentoriaRevenue) / totalBuyers : NET_PER_SALE;

  // Score (simplified)
  const cpaScore = cpa < 50 ? 100 : cpa < 70 ? 60 : cpa < 97 ? 30 : 0;
  const roasScore = roas > 2.5 ? 100 : roas > 2.0 ? 80 : roas > 1.4 ? 50 : roas > 1.0 ? 20 : 0;
  const score = Math.round(cpaScore * 0.5 + roasScore * 0.5);
  const scoreLabel =
    score >= 80 ? "Excelente" : score >= 60 ? "Bom" : score >= 40 ? "Regular" : "Critico";
  const statusText =
    score >= 60
      ? `Operacao saudavel. ROAS ${roas.toFixed(1)}x com CPA dentro da meta.`
      : `Operacao precisa de atencao. CPA R$${cpa.toFixed(0)} ${cpa > 93.6 ? "acima do breakeven" : "acima do ideal"}.`;

  // Daily chart data
  const dailyMap = new Map<string, { spend: number; sales: number; profit: number }>();
  for (const m of currentMetrics) {
    const dateKey = m.date.toISOString().split("T")[0];
    if (!dailyMap.has(dateKey)) dailyMap.set(dateKey, { spend: 0, sales: 0, profit: 0 });
    const d = dailyMap.get(dateKey)!;
    d.spend += m.investment;
    d.sales += m.sales;
    d.profit += m.sales * NET_PER_SALE - m.investment;
  }

  const dailyCpa = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, cpa: d.sales > 0 ? Math.round(d.spend / d.sales) : 0 }));
  const dailySales = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, sales: d.sales }));
  const dailyProfit = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, profit: Math.round(d.profit) }));

  res.json({
    title: "Relatorio de Trafego Pago — Bravy School",
    period: periodLabel,
    generated_at: new Date().toISOString(),
    executive_summary: { status: statusText, score, score_label: scoreLabel },
    kpis: {
      investimento: { value: totalInvestment, formatted: formatBRL(totalInvestment) },
      receita_bruta: { value: grossRevenue, formatted: formatBRL(grossRevenue) },
      receita_liquida: { value: netRevenue, formatted: formatBRL(netRevenue) },
      lucro_liquido: { value: profit, formatted: formatBRL(profit) },
      margem: { value: parseFloat(margin.toFixed(1)), formatted: `${margin.toFixed(1)}%` },
      vendas: { value: totalSales, formatted: String(totalSales) },
      cpa: { value: parseFloat(cpa.toFixed(2)), formatted: formatBRL(cpa) },
      roas: { value: parseFloat(roas.toFixed(2)), formatted: `${roas.toFixed(2)}x` },
      ticket_medio: { value: 97, formatted: "R$97" },
    },
    comparison: {
      vs_previous: {
        vendas: pctChange(totalSales, prevSales),
        cpa: pctChange(cpa, prevCpa),
        lucro: pctChange(profit, prevProfit),
      },
    },
    top_performers: topPerformers,
    worst_performers: worstPerformers,
    ltv: {
      buyers_skills: totalBuyers,
      converted_mentoria: mentoriaConverted,
      conversion_rate: `${conversionRate.toFixed(1)}%`,
      revenue_mentoria: mentoriaRevenue,
      estimated_ltv: formatBRL(estimatedLtv),
    },
    chart_data: { daily_cpa: dailyCpa, daily_sales: dailySales, daily_profit: dailyProfit },
  });
});

export default router;
