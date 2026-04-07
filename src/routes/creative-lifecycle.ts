import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// GET / — Creative lifecycle analysis (Melhoria 26)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const creatives = await prisma.creative.findMany({
      include: { campaign: { select: { id: true, name: true } } },
    });

    const now = new Date();

    const analyzed = creatives.map((c) => {
      const daysActive = Math.floor(
        (now.getTime() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24)
      );
      const currentCtr = c.ctr ?? 0;
      const currentHookRate = c.hookRate ?? 0;
      const currentCpa = c.cpa ?? 0;

      // Estimate initial CTR: assume a degradation curve based on days active
      // If few days, initial ~ current; if many days, initial was likely higher
      const degradationFactor = daysActive > 0 ? Math.min(daysActive * 0.015, 0.5) : 0;
      const initialCtr = currentCtr > 0 ? currentCtr / (1 - degradationFactor) : currentCtr;
      const ctrChangePct =
        initialCtr > 0 ? ((currentCtr - initialCtr) / initialCtr) * 100 : 0;

      // Classify lifecycle stage
      let lifecycleStage: string;
      let recommendation: string;

      if (c.status === "Pausado" && currentCpa > 0 && currentCpa < 60) {
        lifecycleStage = "reserve";
        recommendation = "Criativo pausado com bom CPA. Manter em reserva para reativacao.";
      } else if (
        currentCpa > 70 ||
        ctrChangePct < -40 ||
        daysActive > 25
      ) {
        lifecycleStage = "exhausted";
        recommendation = "Criativo esgotado. Substituir por novo criativo.";
      } else if (
        (currentCpa > 50 && currentCpa <= 70) ||
        ctrChangePct < -20 ||
        daysActive > 14
      ) {
        lifecycleStage = "declining";
        recommendation = "Criativo em declinio. Preparar substituto.";
      } else {
        lifecycleStage = "healthy";
        recommendation = "Criativo saudavel. Manter ativo.";
      }

      // Estimate days remaining: project when CTR will hit 0.8% threshold
      let estimatedDaysRemaining: number | null = null;
      if (currentCtr > 0.8 && ctrChangePct < 0 && daysActive > 0) {
        const dailyDrop = (initialCtr - currentCtr) / daysActive;
        if (dailyDrop > 0) {
          estimatedDaysRemaining = Math.max(
            0,
            Math.round((currentCtr - 0.8) / dailyDrop)
          );
        }
      }

      return {
        id: c.id,
        name: c.name,
        campaign_name: c.campaign.name,
        status: c.status,
        days_active: daysActive,
        lifecycle_stage: lifecycleStage,
        current_ctr: parseFloat(currentCtr.toFixed(2)),
        initial_ctr: parseFloat(initialCtr.toFixed(2)),
        ctr_change_percent: parseFloat(ctrChangePct.toFixed(1)),
        current_hook_rate: parseFloat(currentHookRate.toFixed(2)),
        current_cpa: parseFloat(currentCpa.toFixed(2)),
        estimated_days_remaining: estimatedDaysRemaining,
        recommendation,
      };
    });

    // Summary counts
    const totalActive = analyzed.filter((c) => c.status === "Ativo").length;
    const healthy = analyzed.filter((c) => c.lifecycle_stage === "healthy").length;
    const declining = analyzed.filter((c) => c.lifecycle_stage === "declining").length;
    const exhausted = analyzed.filter((c) => c.lifecycle_stage === "exhausted").length;
    const inReserve = analyzed.filter((c) => c.lifecycle_stage === "reserve").length;

    let status: string;
    let message: string;
    if (declining + exhausted === 0 && healthy > 0) {
      status = "saudavel";
      message = "Todos os criativos estao performando bem.";
    } else if (exhausted > healthy) {
      status = "critico";
      message = `${exhausted} criativo(s) esgotado(s). Producao urgente necessaria.`;
    } else if (declining > 0) {
      status = "atencao";
      message = `${declining} criativo(s) em declinio. Preparar substitutos.`;
    } else {
      status = "estavel";
      message = "Operacao de criativos estavel.";
    }

    // Production queue
    const needed = Math.max(0, 2 - inReserve) + declining;

    res.json({
      summary: {
        total_active: totalActive,
        healthy,
        declining,
        exhausted,
        in_reserve: inReserve,
        status,
        message,
      },
      creatives: analyzed,
      production_queue: {
        needed,
        message:
          needed > 0
            ? `Produzir ${needed} criativo(s): ${declining > 0 ? `${declining} para substituir declinantes` : ""}${declining > 0 && inReserve < 2 ? " + " : ""}${inReserve < 2 ? `${2 - inReserve} para reserva` : ""}`.trim()
            : "Estoque de criativos saudavel. Nenhuma producao urgente.",
      },
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[creative-lifecycle] Error:", error.message);
    res.json({
      summary: { total_active: 0, healthy: 0, declining: 0, exhausted: 0, in_reserve: 0, status: "erro", message: "Erro ao analisar ciclo de vida dos criativos." },
      creatives: [],
      production_queue: { needed: 0, message: "Erro ao calcular fila de producao." },
    });
  }
});

export default router;
