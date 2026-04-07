import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const PRODUCT_PRICE = 97;
const NET_PER_SALE = 93.6;

// GET / — List sales with filters
router.get("/", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = {};

  if (req.query.status) where.status = req.query.status as string;
  if (req.query.campaignId) where.campaignId = req.query.campaignId as string;
  if (req.query.paymentMethod) where.paymentMethod = req.query.paymentMethod as string;

  if (req.query.from || req.query.to) {
    const dateFilter: Record<string, Date> = {};
    if (req.query.from) dateFilter.gte = new Date(req.query.from as string);
    if (req.query.to) dateFilter.lte = new Date(req.query.to as string);
    where.date = dateFilter;
  }

  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 500);
  const offset = parseInt((req.query.offset as string) || "0", 10);

  const [sales, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      include: { campaign: { select: { id: true, name: true } } },
      orderBy: { date: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.sale.count({ where }),
  ]);

  res.json({ data: sales, total, limit, offset });
});

// GET /summary — Totals grouped by status and payment method
router.get("/summary", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = {};
  if (req.query.from || req.query.to) {
    const dateFilter: Record<string, Date> = {};
    if (req.query.from) dateFilter.gte = new Date(req.query.from as string);
    if (req.query.to) dateFilter.lte = new Date(req.query.to as string);
    where.date = dateFilter;
  }

  const sales = await prisma.sale.findMany({ where });

  const total = {
    count: sales.length,
    grossRevenue: sales.reduce((s, v) => s + v.amountGross, 0),
    netRevenue: sales.reduce((s, v) => s + v.amountNet, 0),
  };

  const statusKeys = [
    "approved",
    "refunded",
    "chargeback",
    "pending_boleto",
    "pending_pix",
    "expired",
    "refused",
  ] as const;

  const byStatus: Record<string, { count: number; revenue?: number }> = {};
  for (const key of statusKeys) {
    const group = sales.filter((s) => s.status === key);
    if (key === "approved") {
      byStatus[key] = {
        count: group.length,
        revenue: group.reduce((s, v) => s + v.amountNet, 0),
      };
    } else {
      byStatus[key] = { count: group.length };
    }
  }

  const paymentKeys = ["credit_card", "pix", "boleto"] as const;
  const byPaymentMethod: Record<string, { count: number; revenue: number }> = {};
  for (const key of paymentKeys) {
    const group = sales.filter(
      (s) => s.paymentMethod === key && s.status === "approved"
    );
    byPaymentMethod[key] = {
      count: group.length,
      revenue: group.reduce((s, v) => s + v.amountNet, 0),
    };
  }

  const approvedCount = byStatus.approved?.count || 0;
  const refundedCount = byStatus.refunded?.count || 0;
  const chargebackCount = byStatus.chargeback?.count || 0;
  const totalCompleted = approvedCount + refundedCount + chargebackCount;

  const refundRate = totalCompleted > 0 ? (refundedCount / totalCompleted) * 100 : 0;
  const chargebackRate = totalCompleted > 0 ? (chargebackCount / totalCompleted) * 100 : 0;

  res.json({
    total,
    byStatus,
    byPaymentMethod,
    refundRate,
    chargebackRate,
  });
});

// GET /by-campaign — Sales grouped by campaign
router.get("/by-campaign", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = { status: "approved" };
  if (req.query.from || req.query.to) {
    const dateFilter: Record<string, Date> = {};
    if (req.query.from) dateFilter.gte = new Date(req.query.from as string);
    if (req.query.to) dateFilter.lte = new Date(req.query.to as string);
    where.date = dateFilter;
  }

  const sales = await prisma.sale.findMany({
    where,
    include: { campaign: { select: { id: true, name: true, metrics: true } } },
  });

  const grouped: Record<
    string,
    { name: string; salesCount: number; revenue: number; totalInvestment: number }
  > = {};

  for (const sale of sales) {
    const key = sale.campaignId || "unattributed";
    if (!grouped[key]) {
      grouped[key] = {
        name: sale.campaign?.name || "Sem campanha atribuída",
        salesCount: 0,
        revenue: 0,
        totalInvestment: 0,
      };
      if (sale.campaign?.metrics) {
        grouped[key].totalInvestment = sale.campaign.metrics.reduce(
          (s, m) => s + m.investment,
          0
        );
      }
    }
    grouped[key].salesCount++;
    grouped[key].revenue += sale.amountNet;
  }

  const result = Object.entries(grouped).map(([id, data]) => ({
    campaignId: id,
    name: data.name,
    salesCount: data.salesCount,
    revenue: data.revenue,
    avgCpa:
      data.totalInvestment > 0 && data.salesCount > 0
        ? data.totalInvestment / data.salesCount
        : null,
  }));

  result.sort((a, b) => b.revenue - a.revenue);

  res.json(result);
});

// GET /by-hour — Sales grouped by hour of day
router.get("/by-hour", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = { status: "approved" };
  if (req.query.from || req.query.to) {
    const dateFilter: Record<string, Date> = {};
    if (req.query.from) dateFilter.gte = new Date(req.query.from as string);
    if (req.query.to) dateFilter.lte = new Date(req.query.to as string);
    where.date = dateFilter;
  }

  const sales = await prisma.sale.findMany({ where });

  const hours: { hour: number; count: number; revenue: number }[] = Array.from(
    { length: 24 },
    (_, i) => ({ hour: i, count: 0, revenue: 0 })
  );

  for (const sale of sales) {
    const h = sale.date.getHours();
    hours[h].count++;
    hours[h].revenue += sale.amountNet;
  }

  res.json(hours);
});

// GET /discrepancy — Compare Meta-reported vs Kirvano real sales (Melhoria 5)
router.get("/discrepancy", async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 14);

  const from = req.query.from ? new Date(req.query.from as string) : defaultFrom;
  const to = req.query.to ? new Date(req.query.to as string) : now;

  // Meta-reported data from MetricEntry
  const metricEntries = await prisma.metricEntry.findMany({
    where: { date: { gte: from, lte: to } },
  });

  const metaReportedSales = metricEntries.reduce((s, m) => s + m.sales, 0);
  const metaTotalInvestment = metricEntries.reduce((s, m) => s + m.investment, 0);

  // Kirvano real sales
  const kirvanoRealSales = await prisma.sale.count({
    where: {
      date: { gte: from, lte: to },
      status: "approved",
    },
  });

  const discrepancyCount = metaReportedSales - kirvanoRealSales;
  const discrepancyPercent =
    kirvanoRealSales > 0
      ? ((metaReportedSales - kirvanoRealSales) / kirvanoRealSales) * 100
      : metaReportedSales > 0
        ? 100
        : 0;

  const metaReportedCpa =
    metaReportedSales > 0 ? metaTotalInvestment / metaReportedSales : 0;
  const realCpa =
    kirvanoRealSales > 0 ? metaTotalInvestment / kirvanoRealSales : 0;

  const metaReportedRevenue = metaReportedSales * NET_PER_SALE;
  const realRevenue = kirvanoRealSales * NET_PER_SALE;

  const metaReportedRoas =
    metaTotalInvestment > 0 ? metaReportedRevenue / metaTotalInvestment : 0;
  const realRoas =
    metaTotalInvestment > 0 ? realRevenue / metaTotalInvestment : 0;

  const formatBRL = (v: number) =>
    `R$ ${v.toFixed(2).replace(".", ",")}`;

  const formatDate = (d: Date) =>
    d.toLocaleDateString("pt-BR", { year: "numeric", month: "2-digit", day: "2-digit" });

  let recommendation = "";
  if (discrepancyPercent > 20) {
    recommendation =
      `Meta está reportando ${discrepancyPercent.toFixed(1)}% mais vendas que o Kirvano. ` +
      `CPA real é ${formatBRL(realCpa)} vs ${formatBRL(metaReportedCpa)} reportado pelo Meta. ` +
      `Recomenda-se revisar a configuração do pixel e eventos de conversão.`;
  } else if (discrepancyPercent < -20) {
    recommendation =
      `Kirvano registrou mais vendas que o Meta (${Math.abs(discrepancyPercent).toFixed(1)}% a mais). ` +
      `Pode haver vendas orgânicas ou de outras fontes sendo contabilizadas. ` +
      `ROAS real: ${realRoas.toFixed(2)}x vs ${metaReportedRoas.toFixed(2)}x reportado.`;
  } else if (metaReportedSales === 0 && kirvanoRealSales === 0) {
    recommendation = "Nenhuma venda registrada no período.";
  } else {
    recommendation =
      `Discrepância dentro do aceitável (${discrepancyPercent.toFixed(1)}%). ` +
      `CPA real: ${formatBRL(realCpa)}, ROAS real: ${realRoas.toFixed(2)}x.`;
  }

  res.json({
    period: `${formatDate(from)} a ${formatDate(to)}`,
    meta_reported_sales: metaReportedSales,
    kirvano_real_sales: kirvanoRealSales,
    discrepancy_count: discrepancyCount,
    discrepancy_percent: parseFloat(discrepancyPercent.toFixed(2)),
    meta_reported_cpa: parseFloat(metaReportedCpa.toFixed(2)),
    real_cpa: parseFloat(realCpa.toFixed(2)),
    meta_reported_roas: parseFloat(metaReportedRoas.toFixed(2)),
    real_roas: parseFloat(realRoas.toFixed(2)),
    recommendation,
  });
});

// GET /heatmap — Sales heatmap by day of week and hour (Melhoria 18)
router.get("/heatmap", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = { status: "approved" };
  if (req.query.from || req.query.to) {
    const dateFilter: Record<string, Date> = {};
    if (req.query.from) dateFilter.gte = new Date(req.query.from as string);
    if (req.query.to) dateFilter.lte = new Date(req.query.to as string);
    where.date = dateFilter;
  }

  const sales = await prisma.sale.findMany({ where });

  // Build heatmap: 7 days x 24 hours
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const sale of sales) {
    const day = sale.date.getDay(); // 0=Sunday
    const hour = sale.date.getHours();
    grid[day][hour]++;
  }

  const heatmap: { dayOfWeek: number; hour: number; sales: number }[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      heatmap.push({ dayOfWeek: d, hour: h, sales: grid[d][h] });
    }
  }

  // Generate insights
  const insights: string[] = [];
  const dayNames = ["Domingo", "Segunda", "Terca", "Quarta", "Quinta", "Sexta", "Sabado"];

  // Best hour overall
  const hourTotals = Array(24).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      hourTotals[h] += grid[d][h];
    }
  }
  const bestHour = hourTotals.indexOf(Math.max(...hourTotals));
  if (hourTotals[bestHour] > 0) {
    insights.push(`Melhor horario: ${bestHour}h com ${hourTotals[bestHour]} vendas totais.`);
  }

  // Best day overall
  const dayTotals = Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    dayTotals[d] = grid[d].reduce((a: number, b: number) => a + b, 0);
  }
  const bestDay = dayTotals.indexOf(Math.max(...dayTotals));
  if (dayTotals[bestDay] > 0) {
    insights.push(`Melhor dia: ${dayNames[bestDay]} com ${dayTotals[bestDay]} vendas.`);
  }

  // Dead hours (0 sales across all days)
  const deadHours = hourTotals
    .map((total: number, h: number) => (total === 0 ? h : -1))
    .filter((h: number) => h >= 0);
  if (deadHours.length > 0 && deadHours.length < 12) {
    insights.push(`Horarios sem vendas: ${deadHours.map((h: number) => `${h}h`).join(", ")}.`);
  }

  // Dayparting suggestion
  const totalSales = sales.length;
  if (totalSales >= 10) {
    const top5Hours = hourTotals
      .map((total: number, h: number) => ({ h, total }))
      .sort((a: { total: number }, b: { total: number }) => b.total - a.total)
      .slice(0, 5);
    const topHoursSales = top5Hours.reduce((s: number, x: { total: number }) => s + x.total, 0);
    const topPercent = ((topHoursSales / totalSales) * 100).toFixed(1);
    insights.push(
      `Sugestao dayparting: concentre orcamento nos horarios ${top5Hours.map((x: { h: number }) => `${x.h}h`).join(", ")} (${topPercent}% das vendas).`
    );
  }

  res.json({ heatmap, insights });
});

// GET /ltv — LTV metrics (Melhoria 21)
// NOTE: Must be defined before /:id routes to avoid "ltv" matching as :id
router.get("/ltv", async (_req: Request, res: Response) => {
  const mentoriaTicket = Number(process.env.MENTORIA_TICKET_VALUE) || 3000;

  const [approvedSales, convertedCount, metricEntries] = await Promise.all([
    prisma.sale.findMany({ where: { status: "approved" } }),
    prisma.sale.count({ where: { convertedToMentoria: true } }),
    prisma.metricEntry.findMany(),
  ]);

  const totalSkillsBuyers = approvedSales.length;
  const conversionRate = totalSkillsBuyers > 0
    ? (convertedCount / totalSkillsBuyers) * 100
    : 0;

  const totalAdSpend = metricEntries.reduce((s, m) => s + m.investment, 0);
  const totalSkillsRevenue = totalSkillsBuyers * NET_PER_SALE;
  const skillsRoas = totalAdSpend > 0 ? totalSkillsRevenue / totalAdSpend : 0;

  const estimatedLtvPerBuyer = PRODUCT_PRICE + (conversionRate / 100) * mentoriaTicket;

  const realCpaConsideringLtv = convertedCount > 0 && totalAdSpend > 0
    ? totalAdSpend / (totalSkillsBuyers + convertedCount)
    : null;

  const insights: string[] = [];

  if (totalSkillsBuyers === 0) {
    insights.push("Nenhuma venda aprovada registrada ainda.");
  } else {
    insights.push(
      `De ${totalSkillsBuyers} compradores de Skills, ${convertedCount} converteram para mentoria (${conversionRate.toFixed(1)}%).`
    );
  }

  if (conversionRate > 5) {
    insights.push(
      `Taxa de conversão para mentoria acima de 5%. LTV estimado por comprador: R$${estimatedLtvPerBuyer.toFixed(2)}.`
    );
  } else if (totalSkillsBuyers > 0 && conversionRate <= 5) {
    insights.push(
      `Taxa de conversão para mentoria baixa (${conversionRate.toFixed(1)}%). Oportunidade de aumentar LTV com funil de upsell.`
    );
  }

  if (skillsRoas > 0 && skillsRoas < 1) {
    insights.push(
      `ROAS de Skills isolado está negativo (${skillsRoas.toFixed(2)}x). Conversões de mentoria podem compensar.`
    );
  }

  if (convertedCount > 0) {
    const totalLtvRevenue = totalSkillsRevenue + convertedCount * mentoriaTicket;
    const ltvRoas = totalAdSpend > 0 ? totalLtvRevenue / totalAdSpend : 0;
    insights.push(
      `ROAS considerando LTV completo: ${ltvRoas.toFixed(2)}x (vs ${skillsRoas.toFixed(2)}x apenas Skills).`
    );
  }

  res.json({
    total_skills_buyers: totalSkillsBuyers,
    converted_to_mentoria: convertedCount,
    conversion_rate: parseFloat(conversionRate.toFixed(2)),
    mentoria_ticket: mentoriaTicket,
    total_ad_spend: parseFloat(totalAdSpend.toFixed(2)),
    total_skills_revenue: parseFloat(totalSkillsRevenue.toFixed(2)),
    skills_roas: parseFloat(skillsRoas.toFixed(2)),
    estimated_ltv_per_buyer: parseFloat(estimatedLtvPerBuyer.toFixed(2)),
    real_cpa_considering_ltv: realCpaConsideringLtv
      ? parseFloat(realCpaConsideringLtv.toFixed(2))
      : null,
    insights,
  });
});

// PUT /:id/convert-mentoria — Mark sale as converted to mentoria (Melhoria 21)
router.put("/:id/convert-mentoria", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    const sale = await prisma.sale.update({
      where: { id },
      data: {
        convertedToMentoria: true,
        mentoriaConvertedAt: new Date(),
      },
    });
    res.json(sale);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: "Sale not found", details: message });
  }
});

export default router;
