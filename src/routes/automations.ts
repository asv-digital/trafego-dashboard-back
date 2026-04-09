import { Router, Request, Response } from "express";
import prisma from "../prisma";

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
      breakevenCPA: 93.60,
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

export default router;
