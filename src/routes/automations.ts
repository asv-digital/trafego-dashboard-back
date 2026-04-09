import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { NET_PER_SALE } from "../config/constants";
import { getCurrentAllocation } from "../services/budget-guard";

const router = Router();

// GET /config — Get automation config
router.get("/config", async (_req: Request, res: Response) => {
  const config = await prisma.automationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (!config) {
    // Return defaults
    res.json({
      autoPauseNoSales: true,
      autoPauseSpendLimit: 200,
      autoPauseBreakeven: true,
      breakevenCPA: NET_PER_SALE,
      breakevenMinDays: 3,
      autoScaleWinners: true,
      autoScaleCPAThreshold: 50,
      autoScalePercent: 20,
      autoScaleMinDays: 3,
      autoScaleMaxBudget: 200,
      respectLearningPhase: true,
      learningPhaseHours: 72,
      autoRotateCreatives: false,
      notifyOnAutoAction: true,
      cpaPauseThreshold: 70,
    });
    return;
  }

  res.json(config);
});

// PUT /config — Update automation config
router.put("/config", async (req: Request, res: Response) => {
  const existing = await prisma.automationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  const data = req.body;
  // Remove fields that shouldn't be set by the user
  delete data.id;
  delete data.createdAt;
  delete data.updatedAt;

  let record;
  if (existing) {
    record = await prisma.automationConfig.update({
      where: { id: existing.id },
      data,
    });
  } else {
    record = await prisma.automationConfig.create({ data });
  }

  res.json(record);
});

// GET /budget-allocation — Current budget allocation by type (Ponto 5)
router.get("/budget-allocation", async (_req: Request, res: Response) => {
  try {
    const allocation = await getCurrentAllocation();
    const config = await prisma.automationConfig.findFirst({ orderBy: { updatedAt: "desc" } });

    const dailyTarget = parseFloat(process.env.DAILY_BUDGET_TARGET || "500");

    res.json({
      allocation,
      caps: {
        prospection: config?.budgetCapProspection ?? 250,
        remarketing: config?.budgetCapRemarketing ?? 200,
        asc: config?.budgetCapASC ?? 150,
      },
      floors: {
        prospection: config?.budgetFloorProspection ?? 100,
        remarketing: config?.budgetFloorRemarketing ?? 100,
      },
      daily_target: dailyTarget,
    });
  } catch (err: unknown) {
    console.error("[automations] Error:", (err as Error).message);
    res.json({ allocation: { prospection: 0, remarketing: 0, asc: 0, total: 0, reserve: 0 }, caps: {}, floors: {}, daily_target: 500 });
  }
});

export default router;
