import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const PRODUCT_PRICE = 97;
const NET_PER_SALE = 93.6;
const KIRVANO_FEE_RATE = 0.035;

// ---------------------------------------------------------------------------
// GET / — Profit calculation (Melhoria 28)
// ---------------------------------------------------------------------------
router.get("/", async (req: Request, res: Response) => {
  try {
    const periodParam = (req.query.period as string) || "7d";
    const periodDays = periodParam === "30d" ? 30 : periodParam === "14d" ? 14 : 7;

    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - periodDays);

    // Get MetricEntry for period: sum investment
    const metrics = await prisma.metricEntry.findMany({
      where: { date: { gte: start, lte: now } },
    });

    const adSpend = metrics.reduce((s, m) => s + m.investment, 0);

    // Get Sale count (approved) for period
    const totalSales = await prisma.sale.count({
      where: {
        date: { gte: start, lte: now },
        status: "approved",
      },
    });

    // Calculations
    const grossRevenue = totalSales * PRODUCT_PRICE;
    const kirvanoFee = grossRevenue * KIRVANO_FEE_RATE;
    const netRevenue = grossRevenue - kirvanoFee;
    const profit = netRevenue - adSpend;
    const profitMargin = grossRevenue > 0 ? (profit / grossRevenue) * 100 : 0;
    const realRoas = adSpend > 0 ? netRevenue / adSpend : 0;

    // Daily averages
    const dailySpend = periodDays > 0 ? adSpend / periodDays : 0;
    const dailySales = periodDays > 0 ? totalSales / periodDays : 0;
    const dailyProfit = periodDays > 0 ? profit / periodDays : 0;
    const dailyRevenue = periodDays > 0 ? netRevenue / periodDays : 0;

    // Monthly projection
    const projectedMonthlyRevenue = dailyRevenue * 30;
    const projectedMonthlySpend = dailySpend * 30;
    const projectedMonthlyProfit = dailyProfit * 30;
    const projectedMonthlySales = Math.round(dailySales * 30);

    // Breakeven
    const breakevenSalesPerDay = dailySpend > 0 ? Math.ceil(dailySpend / NET_PER_SALE) : 0;
    const currentSalesPerDay = periodDays > 0 ? totalSales / periodDays : 0;

    res.json({
      period: periodParam,
      days: periodDays,
      total_sales: totalSales,
      ad_spend: parseFloat(adSpend.toFixed(2)),
      gross_revenue: parseFloat(grossRevenue.toFixed(2)),
      kirvano_fee: parseFloat(kirvanoFee.toFixed(2)),
      net_revenue: parseFloat(netRevenue.toFixed(2)),
      profit: parseFloat(profit.toFixed(2)),
      profit_margin: parseFloat(profitMargin.toFixed(2)),
      real_roas: parseFloat(realRoas.toFixed(2)),
      daily_averages: {
        spend: parseFloat(dailySpend.toFixed(2)),
        sales: parseFloat(dailySales.toFixed(2)),
        revenue: parseFloat(dailyRevenue.toFixed(2)),
        profit: parseFloat(dailyProfit.toFixed(2)),
      },
      monthly_projection: {
        revenue: parseFloat(projectedMonthlyRevenue.toFixed(2)),
        spend: parseFloat(projectedMonthlySpend.toFixed(2)),
        profit: parseFloat(projectedMonthlyProfit.toFixed(2)),
        sales: projectedMonthlySales,
      },
      breakeven_sales_per_day: breakevenSalesPerDay,
      current_sales_per_day: parseFloat(currentSalesPerDay.toFixed(2)),
      above_breakeven: currentSalesPerDay >= breakevenSalesPerDay,
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[profit] Error calculating profit:", error.message);
    res.status(500).json({ error: "Erro ao calcular lucro." });
  }
});

export default router;
