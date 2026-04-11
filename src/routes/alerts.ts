import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

interface Alert {
  level: "critical" | "red" | "yellow" | "green";
  campaign: string;
  campaignId: string;
  // Meta campaign id — usado pelo frontend pra pausar via Meta Graph API.
  // Pode ser null se a campanha nunca foi lançada no Meta (apenas no DB).
  metaCampaignId: string | null;
  adSet?: string;
  message: string;
  action: string;
  metric?: string;
  value?: number;
}

async function getThresholds() {
  const config = await prisma.automationConfig.findFirst({ orderBy: { updatedAt: "desc" } });
  return {
    cpaPauseThreshold: config?.cpaPauseThreshold ?? 70,
    autoScaleCPAThreshold: config?.autoScaleCPAThreshold ?? 50,
    autoPauseSpendLimit: config?.autoPauseSpendLimit ?? 200,
    minDays: 3, // Passo 10: sempre 3 dias
  };
}

// GET generated alerts
router.get("/", async (_req: Request, res: Response) => {
  const thresholds = await getThresholds();

  const campaigns = await prisma.campaign.findMany({
    include: {
      metrics: { orderBy: { date: "desc" } },
    },
  });

  const alerts: Alert[] = [];

  for (const campaign of campaigns) {
    if (campaign.metrics.length === 0) continue;

    // Ignorar campanhas em fase de aprendizado (Passo 9)
    if (campaign.isInLearningPhase) continue;

    const latest = campaign.metrics[0];
    const latestThree = campaign.metrics.slice(0, thresholds.minDays);

    const cpa = latest.sales > 0 ? latest.investment / latest.sales : null;
    const ctr = latest.impressions > 0 ? (latest.clicks / latest.impressions) * 100 : 0;
    const cpm = latest.impressions > 0 ? (latest.investment / latest.impressions) * 1000 : 0;
    const frequency = latest.frequency ?? 0;

    // IMEDIATO: Gasto > limite sem vendas
    if (latest.investment > thresholds.autoPauseSpendLimit && latest.sales === 0) {
      alerts.push({
        level: "critical",
        campaign: campaign.name,
        campaignId: campaign.id,
        metaCampaignId: campaign.metaCampaignId ?? null,
        message: `Gasto R$${latest.investment.toFixed(2)} sem nenhuma venda`,
        action: "Pausar imediatamente este conjunto de anúncios.",
      });
    }

    // CPA > threshold por 3+ períodos consecutivos (Passo 10)
    if (cpa && cpa > thresholds.cpaPauseThreshold && latestThree.length >= thresholds.minDays) {
      const allAbove = latestThree.every((m) => {
        const mCpa = m.sales > 0 ? m.investment / m.sales : 0;
        return mCpa > thresholds.cpaPauseThreshold && m.sales > 0;
      });
      if (allAbove) {
        alerts.push({
          level: "red",
          campaign: campaign.name,
          campaignId: campaign.id,
          metaCampaignId: campaign.metaCampaignId ?? null,
          message: `CPA acima de R$${thresholds.cpaPauseThreshold} por ${thresholds.minDays}+ dias consecutivos (R$${cpa.toFixed(2)})`,
          action: "Matar conjunto. CPA acima do limite sustentado.",
          metric: "CPA",
          value: cpa,
        });
      }
    }

    // CPA entre threshold de escala e pausa
    if (cpa && cpa >= thresholds.autoScaleCPAThreshold && cpa <= thresholds.cpaPauseThreshold) {
      alerts.push({
        level: "yellow",
        campaign: campaign.name,
        campaignId: campaign.id,
        metaCampaignId: campaign.metaCampaignId ?? null,
        message: `CPA em zona de alerta: R$${cpa.toFixed(2)}`,
        action: "Observar. Testar novos criativos.",
        metric: "CPA",
        value: cpa,
      });
    }

    // CPA < threshold de escala por 3+ períodos → escalar (Passo 10)
    if (cpa && cpa < thresholds.autoScaleCPAThreshold && latestThree.length >= thresholds.minDays) {
      const allBelow = latestThree.every((m) => {
        const mCpa = m.sales > 0 ? m.investment / m.sales : 0;
        return mCpa > 0 && mCpa < thresholds.autoScaleCPAThreshold && m.sales > 0;
      });
      if (allBelow) {
        alerts.push({
          level: "green",
          campaign: campaign.name,
          campaignId: campaign.id,
          metaCampaignId: campaign.metaCampaignId ?? null,
          message: `CPA excelente por ${thresholds.minDays}+ dias: R$${cpa.toFixed(2)}`,
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
        metaCampaignId: campaign.metaCampaignId ?? null,
        message: `CTR muito baixo: ${ctr.toFixed(2)}%`,
        action: "Criativo fraco. Trocar hooks e criativos.",
        metric: "CTR",
        value: ctr,
      });
    }

    // CTR > 1.5% mas CPA alto
    if (ctr > 1.5 && cpa && cpa > thresholds.cpaPauseThreshold) {
      alerts.push({
        level: "yellow",
        campaign: campaign.name,
        campaignId: campaign.id,
        metaCampaignId: campaign.metaCampaignId ?? null,
        message: `CTR alto (${ctr.toFixed(2)}%) mas CPA alto (R$${cpa.toFixed(2)})`,
        action: "LP fraca. Pessoas clicam mas não compram. Revisar página.",
        metric: "CTR+CPA",
      });
    }

    // IMEDIATO: Frequência > 5
    if (frequency > 5) {
      alerts.push({
        level: "red",
        campaign: campaign.name,
        campaignId: campaign.id,
        metaCampaignId: campaign.metaCampaignId ?? null,
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
        metaCampaignId: campaign.metaCampaignId ?? null,
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
