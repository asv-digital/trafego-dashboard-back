import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

interface Alert {
  level: "critical" | "red" | "yellow" | "green";
  campaign: string;
  campaignId: string;
  adSet?: string;
  message: string;
  action: string;
  metric?: string;
  value?: number;
}

// GET generated alerts
router.get("/", async (_req: Request, res: Response) => {
  const campaigns = await prisma.campaign.findMany({
    include: {
      metrics: { orderBy: { date: "desc" } },
    },
  });

  const alerts: Alert[] = [];

  for (const campaign of campaigns) {
    if (campaign.metrics.length === 0) continue;

    const latest = campaign.metrics[0];
    const latestTwo = campaign.metrics.slice(0, 2);

    const cpa = latest.sales > 0 ? latest.investment / latest.sales : null;
    const ctr = latest.impressions > 0 ? (latest.clicks / latest.impressions) * 100 : 0;
    const cpm = latest.impressions > 0 ? (latest.investment / latest.impressions) * 1000 : 0;
    const frequency = latest.frequency ?? 0;

    // Gasto > R$200 sem vendas
    if (latest.investment > 200 && latest.sales === 0) {
      alerts.push({
        level: "critical",
        campaign: campaign.name,
        campaignId: campaign.id,
        message: `Gasto R$${latest.investment.toFixed(2)} sem nenhuma venda`,
        action: "Pausar imediatamente este conjunto de anúncios.",
      });
    }

    // CPA > R$70 por 2 períodos consecutivos
    if (cpa && cpa > 70) {
      const prevCpa = latestTwo[1]?.sales > 0 ? latestTwo[1].investment / latestTwo[1].sales : null;
      if (prevCpa && prevCpa > 70) {
        alerts.push({
          level: "red",
          campaign: campaign.name,
          campaignId: campaign.id,
          message: `CPA acima de R$70 por 2 períodos consecutivos (R$${cpa.toFixed(2)})`,
          action: "Matar conjunto. CPA acima do limite por mais de 1 período.",
          metric: "CPA",
          value: cpa,
        });
      }
    }

    // CPA entre R$50-70
    if (cpa && cpa >= 50 && cpa <= 70) {
      alerts.push({
        level: "yellow",
        campaign: campaign.name,
        campaignId: campaign.id,
        message: `CPA em zona de alerta: R$${cpa.toFixed(2)}`,
        action: "Observar. Testar novos criativos.",
        metric: "CPA",
        value: cpa,
      });
    }

    // CPA < R$50 por 2+ registros → escalar
    if (cpa && cpa < 50 && latestTwo.length >= 2) {
      const prevCpa = latestTwo[1]?.sales > 0 ? latestTwo[1].investment / latestTwo[1].sales : null;
      if (prevCpa && prevCpa < 50) {
        alerts.push({
          level: "green",
          campaign: campaign.name,
          campaignId: campaign.id,
          message: `CPA excelente por 2+ períodos: R$${cpa.toFixed(2)}`,
          action: "Escalar 20-30% o orçamento.",
          metric: "CPA",
          value: cpa,
        });
      }
    }

    // CTR < 0.8%
    if (ctr < 0.8) {
      alerts.push({
        level: "yellow",
        campaign: campaign.name,
        campaignId: campaign.id,
        message: `CTR muito baixo: ${ctr.toFixed(2)}%`,
        action: "Criativo fraco. Trocar hooks e criativos.",
        metric: "CTR",
        value: ctr,
      });
    }

    // CTR > 1.5% mas CPA alto
    if (ctr > 1.5 && cpa && cpa > 70) {
      alerts.push({
        level: "yellow",
        campaign: campaign.name,
        campaignId: campaign.id,
        message: `CTR alto (${ctr.toFixed(2)}%) mas CPA alto (R$${cpa.toFixed(2)})`,
        action: "LP fraca. Pessoas clicam mas não compram. Revisar página.",
        metric: "CTR+CPA",
      });
    }

    // Frequência > 5
    if (frequency > 5) {
      alerts.push({
        level: "red",
        campaign: campaign.name,
        campaignId: campaign.id,
        message: `Frequência muito alta: ${frequency.toFixed(1)}`,
        action: "Criativo saturado. Trocar criativo urgente.",
        metric: "Frequência",
        value: frequency,
      });
    }

    // CPM muito alto (> R$50)
    if (cpm > 50) {
      alerts.push({
        level: "yellow",
        campaign: campaign.name,
        campaignId: campaign.id,
        message: `CPM muito alto: R$${cpm.toFixed(2)}`,
        action: "Público pequeno demais. Expandir audiência.",
        metric: "CPM",
        value: cpm,
      });
    }
  }

  // Sort: critical first, then red, yellow, green
  const order = { critical: 0, red: 1, yellow: 2, green: 3 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  res.json(alerts);
});

export default router;
