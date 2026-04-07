import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const NET_PER_SALE = 93.6;

// POST / — Create or update monthly goal
router.post("/", async (req: Request, res: Response) => {
  const { month, targetSales, targetCpa, targetRoas, targetProfit } = req.body;

  if (!month || targetSales == null || targetCpa == null || targetRoas == null) {
    res.status(400).json({ error: "month, targetSales, targetCpa e targetRoas são obrigatórios." });
    return;
  }

  const goal = await prisma.monthlyGoal.upsert({
    where: { month },
    create: {
      month,
      targetSales: parseInt(targetSales),
      targetCpa: parseFloat(targetCpa),
      targetRoas: parseFloat(targetRoas),
      targetProfit: targetProfit != null ? parseFloat(targetProfit) : null,
    },
    update: {
      targetSales: parseInt(targetSales),
      targetCpa: parseFloat(targetCpa),
      targetRoas: parseFloat(targetRoas),
      targetProfit: targetProfit != null ? parseFloat(targetProfit) : null,
    },
  });

  res.json(goal);
});

// GET /progress — Current month progress
router.get("/progress", async (_req: Request, res: Response) => {
  const now = new Date();
  const year = now.getFullYear();
  const monthNum = now.getMonth(); // 0-indexed
  const currentMonth = `${year}-${String(monthNum + 1).padStart(2, "0")}`;

  const goal = await prisma.monthlyGoal.findUnique({ where: { month: currentMonth } });

  if (!goal) {
    res.json({ message: "Nenhuma meta definida para este mês.", status: "no_goal" });
    return;
  }

  const monthStart = new Date(year, monthNum, 1);
  const monthEnd = new Date(year, monthNum + 1, 0, 23, 59, 59, 999);
  const totalDaysInMonth = new Date(year, monthNum + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const daysRemaining = totalDaysInMonth - daysElapsed;

  const [salesCount, metricEntries] = await Promise.all([
    prisma.sale.count({
      where: {
        status: "approved",
        date: { gte: monthStart, lte: monthEnd },
      },
    }),
    prisma.metricEntry.findMany({
      where: { date: { gte: monthStart, lte: monthEnd } },
    }),
  ]);

  const totalInvestment = metricEntries.reduce((s, m) => s + m.investment, 0);
  const totalRevenue = salesCount * NET_PER_SALE;
  const currentCpa = salesCount > 0 ? totalInvestment / salesCount : 0;
  const currentRoas = totalInvestment > 0 ? totalRevenue / totalInvestment : 0;
  const currentProfit = totalRevenue - totalInvestment;

  // Projections
  const dailySalesRate = daysElapsed > 0 ? salesCount / daysElapsed : 0;
  const projectedSales = Math.round(dailySalesRate * totalDaysInMonth);
  const projectedProfit = daysElapsed > 0
    ? (currentProfit / daysElapsed) * totalDaysInMonth
    : 0;

  const salesPercent = goal.targetSales > 0
    ? parseFloat(((salesCount / goal.targetSales) * 100).toFixed(1))
    : 0;
  const profitPercent = goal.targetProfit && goal.targetProfit > 0
    ? parseFloat(((currentProfit / goal.targetProfit) * 100).toFixed(1))
    : null;

  const salesNeededPerDay = daysRemaining > 0
    ? Math.ceil((goal.targetSales - salesCount) / daysRemaining)
    : 0;

  const salesOnTrack = projectedSales >= goal.targetSales;
  const cpaOnTrack = currentCpa > 0 && currentCpa <= goal.targetCpa;
  const roasOnTrack = currentRoas >= goal.targetRoas;
  const profitOnTrack = goal.targetProfit
    ? projectedProfit >= goal.targetProfit
    : null;

  // CPA trend: compare last 3 days vs previous 3 days
  const cpaTrend = calcTrend(metricEntries, now);

  // ROAS trend
  const roasTrend = calcRoasTrend(metricEntries, now);

  // Overall status
  const onTrackCount = [salesOnTrack, cpaOnTrack, roasOnTrack].filter(Boolean).length;
  let status: "ahead" | "on_track" | "behind";
  if (onTrackCount === 3 && salesPercent > (daysElapsed / totalDaysInMonth) * 100 + 5) {
    status = "ahead";
  } else if (onTrackCount >= 2) {
    status = "on_track";
  } else {
    status = "behind";
  }

  // Message in Portuguese
  let message: string;
  if (status === "ahead") {
    message = `Ótimo ritmo! ${salesCount} vendas de ${goal.targetSales} (${salesPercent}%). Projeção: ${projectedSales} vendas até o fim do mês.`;
  } else if (status === "on_track") {
    message = `No caminho certo. ${salesCount} vendas de ${goal.targetSales}. Precisa de ${salesNeededPerDay} vendas/dia para bater a meta.`;
  } else {
    message = `Atenção: ${salesCount} de ${goal.targetSales} vendas (${salesPercent}%). Precisa acelerar para ${salesNeededPerDay} vendas/dia.`;
  }

  res.json({
    month: currentMonth,
    goals: {
      sales: {
        target: goal.targetSales,
        current: salesCount,
        percent: salesPercent,
        projected: projectedSales,
        on_track: salesOnTrack,
      },
      cpa: {
        target: goal.targetCpa,
        current: parseFloat(currentCpa.toFixed(2)),
        on_track: cpaOnTrack,
        trend: cpaTrend,
      },
      roas: {
        target: goal.targetRoas,
        current: parseFloat(currentRoas.toFixed(2)),
        on_track: roasOnTrack,
        trend: roasTrend,
      },
      profit: {
        target: goal.targetProfit,
        current: parseFloat(currentProfit.toFixed(2)),
        percent: profitPercent,
        projected: parseFloat(projectedProfit.toFixed(2)),
        on_track: profitOnTrack,
      },
    },
    days_elapsed: daysElapsed,
    days_remaining: daysRemaining,
    daily_rate_needed: {
      sales_per_day: salesNeededPerDay,
      current_rate: parseFloat(dailySalesRate.toFixed(2)),
      gap: parseFloat((salesNeededPerDay - dailySalesRate).toFixed(2)),
    },
    status,
    message,
  });
});

function calcTrend(
  entries: { date: Date; investment: number; sales: number }[],
  now: Date
): "improving" | "stable" | "worsening" {
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const sixDaysAgo = new Date(now);
  sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);

  const recent = entries.filter((e) => e.date >= threeDaysAgo);
  const previous = entries.filter((e) => e.date >= sixDaysAgo && e.date < threeDaysAgo);

  const recentSales = recent.reduce((s, m) => s + m.sales, 0);
  const recentSpend = recent.reduce((s, m) => s + m.investment, 0);
  const prevSales = previous.reduce((s, m) => s + m.sales, 0);
  const prevSpend = previous.reduce((s, m) => s + m.investment, 0);

  const recentCpa = recentSales > 0 ? recentSpend / recentSales : 999;
  const prevCpa = prevSales > 0 ? prevSpend / prevSales : 999;

  if (recentCpa < prevCpa * 0.9) return "improving";
  if (recentCpa > prevCpa * 1.1) return "worsening";
  return "stable";
}

function calcRoasTrend(
  entries: { date: Date; investment: number; sales: number }[],
  now: Date
): "improving" | "stable" | "worsening" {
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const sixDaysAgo = new Date(now);
  sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);

  const recent = entries.filter((e) => e.date >= threeDaysAgo);
  const previous = entries.filter((e) => e.date >= sixDaysAgo && e.date < threeDaysAgo);

  const recentSales = recent.reduce((s, m) => s + m.sales, 0);
  const recentSpend = recent.reduce((s, m) => s + m.investment, 0);
  const prevSales = previous.reduce((s, m) => s + m.sales, 0);
  const prevSpend = previous.reduce((s, m) => s + m.investment, 0);

  const recentRoas = recentSpend > 0 ? (recentSales * NET_PER_SALE) / recentSpend : 0;
  const prevRoas = prevSpend > 0 ? (prevSales * NET_PER_SALE) / prevSpend : 0;

  if (recentRoas > prevRoas * 1.1) return "improving";
  if (recentRoas < prevRoas * 0.9) return "worsening";
  return "stable";
}

export default router;
