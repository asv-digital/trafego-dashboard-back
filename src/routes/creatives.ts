import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { distributeCreative } from "../services/creative-distributor";
import { logAction } from "./actions";
import { checkCreativeStock } from "../services/creative-stock";

const router = Router();

// GET all creatives
router.get("/", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = {};
  if (req.query.campaignId) where.campaignId = req.query.campaignId as string;

  const creatives = await prisma.creative.findMany({
    where,
    include: { campaign: { select: { id: true, name: true } } },
    orderBy: { cpa: "asc" },
  });

  const now = new Date();
  const enriched = creatives.map((c) => {
    const daysActive = Math.floor((now.getTime() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      ...c,
      daysActive,
      lifetimeAlert: daysActive > 21,
    };
  });

  res.json(enriched);
});

// POST create creative
router.post("/", async (req: Request, res: Response) => {
  const { name, type, status, ctr, hookRate, cpa, campaignId } = req.body;
  const creative = await prisma.creative.create({
    data: {
      name,
      type,
      status: status || "Ativo",
      ctr: ctr ? parseFloat(ctr) : null,
      hookRate: hookRate ? parseFloat(hookRate) : null,
      cpa: cpa ? parseFloat(cpa) : null,
      campaignId,
    },
    include: { campaign: { select: { id: true, name: true } } },
  });
  res.status(201).json(creative);

  // Auto-distribute active creatives in background
  if (creative.status === "Ativo") {
    distributeCreative(creative.id, creative.name).catch((err) => {
      console.error(`[Creatives] Erro na distribuição automática do criativo ${creative.id}:`, err);
      logAction({
        action: "distribute_creative_failed",
        entityType: "creative",
        entityId: creative.id,
        entityName: creative.name,
        details: `Falha na distribuição automática: ${err instanceof Error ? err.message : String(err)}`,
        source: "automation",
      }).catch(() => {});
    });
  }
});

// PATCH update creative
router.patch("/:id", async (req: Request, res: Response) => {
  const data: Record<string, unknown> = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.type !== undefined) data.type = req.body.type;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.ctr !== undefined) data.ctr = parseFloat(req.body.ctr);
  if (req.body.hookRate !== undefined) data.hookRate = parseFloat(req.body.hookRate);
  if (req.body.cpa !== undefined) data.cpa = parseFloat(req.body.cpa);

  const id = req.params.id as string;
  const creative = await prisma.creative.update({
    where: { id },
    data,
    include: { campaign: { select: { id: true, name: true } } },
  });
  res.json(creative);
});

// DELETE creative
router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await prisma.creative.delete({ where: { id } });
  res.status(204).send();
});

// GET /stock — Creative stock alert (Ponto 7)
router.get("/stock", async (_req: Request, res: Response) => {
  try {
    const stock = await checkCreativeStock();
    res.json(stock);
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[creatives] Error checking stock:", error.message);
    res.json({ healthy_count: 0, declining_count: 0, exhausted_count: 0, alert_level: "critical", days_until_crisis: 0, top_angle: null, recommendation: "Erro ao verificar estoque." });
  }
});

// GET /thruplay-analysis — ThruPlay rate analysis (Ponto 8)
router.get("/thruplay-analysis", async (_req: Request, res: Response) => {
  try {
    const creatives = await prisma.creative.findMany({
      where: { status: "Ativo" },
      include: { campaign: { select: { id: true, name: true } } },
    });

    const now = new Date();
    const analyzed = [];

    for (const c of creatives) {
      const daysActive = Math.floor((now.getTime() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24));

      // Get recent thruplay from MetricEntry matching this creative's campaign
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const recentMetrics = await prisma.metricEntry.findMany({
        where: { campaignId: c.campaignId, date: { gte: sevenDaysAgo }, thruplayRate: { not: null } },
        orderBy: { date: "desc" },
        take: 7,
      });

      // Get first week metrics for comparison
      const firstWeekEnd = new Date(c.createdAt);
      firstWeekEnd.setDate(firstWeekEnd.getDate() + 7);
      const firstWeekMetrics = await prisma.metricEntry.findMany({
        where: { campaignId: c.campaignId, date: { gte: c.createdAt, lte: firstWeekEnd }, thruplayRate: { not: null } },
      });

      const currentThruplay = recentMetrics.length > 0
        ? recentMetrics.reduce((sum, m) => sum + (m.thruplayRate || 0), 0) / recentMetrics.length
        : null;

      const initialThruplay = firstWeekMetrics.length > 0
        ? firstWeekMetrics.reduce((sum, m) => sum + (m.thruplayRate || 0), 0) / firstWeekMetrics.length
        : null;

      let contentFatigue = false;
      let diagnosis = "";

      if (currentThruplay !== null && initialThruplay !== null && initialThruplay > 0) {
        const thruplayDrop = (initialThruplay - currentThruplay) / initialThruplay;
        const hookStable = c.hookRate != null && c.hookRate > 0;

        if (hookStable && thruplayDrop > 0.20) {
          contentFatigue = true;
          diagnosis = `Hook ainda funciona mas ThruPlay caiu ${(thruplayDrop * 100).toFixed(0)}%. Refazer corpo do video mantendo os primeiros 3s.`;
        } else if (thruplayDrop > 0.20) {
          diagnosis = `ThruPlay caiu ${(thruplayDrop * 100).toFixed(0)}%. Considere trocar o criativo.`;
        }
      }

      let thruplayStatus: "healthy" | "warning" | "critical" = "healthy";
      if (currentThruplay !== null) {
        if (currentThruplay < 8) thruplayStatus = "critical";
        else if (currentThruplay < 15) thruplayStatus = "warning";
      }

      analyzed.push({
        id: c.id,
        name: c.name,
        campaign_name: c.campaign.name,
        days_active: daysActive,
        hook_rate: c.hookRate ? parseFloat((c.hookRate * 100).toFixed(1)) : null,
        current_thruplay: currentThruplay ? parseFloat(currentThruplay.toFixed(1)) : null,
        initial_thruplay: initialThruplay ? parseFloat(initialThruplay.toFixed(1)) : null,
        thruplay_status: thruplayStatus,
        content_fatigue: contentFatigue,
        diagnosis: diagnosis || (thruplayStatus === "healthy" ? "ThruPlay saudavel." : thruplayStatus === "warning" ? "ThruPlay moderado." : "ThruPlay baixo. Conteudo nao prende."),
      });
    }

    res.json({ creatives: analyzed });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[creatives] Error analyzing thruplay:", error.message);
    res.json({ creatives: [] });
  }
});

export default router;
