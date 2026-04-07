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

export default router;
