import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { canIncreaseBudget, canDecreaseBudget } from "./budget-guard";
import { NET_PER_SALE } from "../config/constants";

const META_BASE = "https://graph.facebook.com/v19.0";

async function updateCampaignBudget(campaignId: string, newBudgetReais: number): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daily_budget: Math.round(newBudgetReais * 100), // Meta usa centavos
        access_token: metaToken,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[REBALANCE] Erro ao atualizar budget da campanha ${campaignId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[REBALANCE] Erro ao atualizar budget da campanha ${campaignId}:`, err);
    return false;
  }
}

async function pauseCampaign(campaignId: string): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "PAUSED",
        access_token: metaToken,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[REBALANCE] Erro ao pausar campanha ${campaignId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[REBALANCE] Erro ao pausar campanha ${campaignId}:`, err);
    return false;
  }
}

interface RebalanceRecommendation {
  campaignId: string;
  campaignName: string;
  currentBudget: number;
  suggestedBudget: number;
  action: "increase" | "decrease" | "pause" | "maintain";
  reason: string;
}

function computeRecommendations(
  campaigns: Array<{
    id: string;
    name: string;
    dailyBudget: number;
    metrics: Array<{ investment: number; sales: number }>;
  }>
): RebalanceRecommendation[] {
  const results: RebalanceRecommendation[] = [];

  for (const campaign of campaigns) {
    if (campaign.metrics.length === 0) continue;

    const totalSpend = campaign.metrics.reduce((s, m) => s + m.investment, 0);
    const totalSales = campaign.metrics.reduce((s, m) => s + m.sales, 0);
    const avgCpa = totalSales > 0 ? totalSpend / totalSales : totalSpend > 0 ? 999 : 0;
    const dailyBudget = campaign.dailyBudget;

    let suggestedBudget: number;
    let action: RebalanceRecommendation["action"];
    let reason: string;

    if (avgCpa < 50 && totalSales >= 3) {
      suggestedBudget = parseFloat((dailyBudget * 1.3).toFixed(2));
      action = "increase";
      reason = `CPA de R$${avgCpa.toFixed(2)} com ${totalSales} vendas. Top performer, aumentar 30%.`;
    } else if (avgCpa > 70 && totalSales > 0) {
      suggestedBudget = parseFloat((dailyBudget * 0.6).toFixed(2));
      action = "decrease";
      reason = `CPA de R$${avgCpa.toFixed(2)} acima do ideal. Reduzir 40%.`;
    } else if (totalSales === 0 && totalSpend > 150) {
      suggestedBudget = 0;
      action = "pause";
      reason = `R$${totalSpend.toFixed(2)} investidos sem vendas. Pausar campanha.`;
    } else {
      action = "maintain";
      suggestedBudget = dailyBudget;
      reason = "Performance moderada. Manter budget atual.";
    }

    results.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      currentBudget: dailyBudget,
      suggestedBudget,
      action,
      reason,
    });
  }

  return results;
}

export async function executeBudgetRebalance(): Promise<void> {
  console.log("[REBALANCE] Iniciando rebalanceamento de budget...");

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const campaigns = await prisma.campaign.findMany({
      where: { status: "Ativa" },
      include: {
        metrics: {
          where: { date: { gte: sevenDaysAgo, lte: now } },
          orderBy: { date: "desc" },
        },
      },
    });

    const recommendations = computeRecommendations(campaigns);
    const actionable = recommendations.filter((r) => r.action !== "maintain");

    if (actionable.length === 0) {
      console.log("[REBALANCE] Nenhuma ação necessária.");
      return;
    }

    const notifyConfig = await prisma.automationConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    const shouldNotify = notifyConfig?.notifyOnAutoAction ?? true;

    for (const rec of actionable) {
      const lockCheck = await canAutomate('campaign', rec.campaignId, 'budget_rebalancer');
      if (!lockCheck.allowed) {
        console.log(`[REBALANCE] Pulando ${rec.campaignName} — ${lockCheck.reason}`);
        continue;
      }

      let success = false;
      let finalBudget = rec.suggestedBudget;

      if (rec.action === "increase") {
        const increment = rec.suggestedBudget - rec.currentBudget;
        const budgetCheck = await canIncreaseBudget(rec.campaignName, increment);
        if (!budgetCheck.allowed) {
          console.log(`[REBALANCE] Pulando increase ${rec.campaignName} — ${budgetCheck.reason}`);
          continue;
        }
        if (budgetCheck.maxIncrease < increment) {
          finalBudget = rec.currentBudget + budgetCheck.maxIncrease;
          console.log(`[REBALANCE] Escala parcial ${rec.campaignName}: ${budgetCheck.reason}`);
        }
      } else if (rec.action === "decrease") {
        const decrement = rec.currentBudget - rec.suggestedBudget;
        const budgetCheck = await canDecreaseBudget(rec.campaignName, decrement);
        if (!budgetCheck.allowed) {
          console.log(`[REBALANCE] Pulando decrease ${rec.campaignName} — ${budgetCheck.reason}`);
          continue;
        }
        if (budgetCheck.maxDecrease < decrement) {
          finalBudget = rec.currentBudget - budgetCheck.maxDecrease;
        }
      }

      if (rec.action === "pause") {
        success = await pauseCampaign(rec.campaignId);
      } else {
        success = await updateCampaignBudget(rec.campaignId, finalBudget);
      }

      if (success) {
        await acquireLock('campaign', rec.campaignId, 'budget_rebalancer', rec.action, rec.currentBudget, rec.suggestedBudget);
        const details =
          rec.action === "pause"
            ? `Budget rebalance: campanha pausada. ${rec.reason}`
            : `Budget rebalance: R$${rec.currentBudget} → R$${rec.suggestedBudget}. ${rec.reason}`;

        await logAction({
          action: `budget_rebalance_${rec.action}`,
          entityType: "campaign",
          entityId: rec.campaignId,
          entityName: rec.campaignName,
          details,
          source: "budget_rebalance",
        });

        if (shouldNotify) {
          await sendNotification("auto_action", {
            action: rec.action === "increase" ? "ESCALADO" : rec.action === "decrease" ? "REDUZIDO" : "PAUSADO",
            adset: rec.campaignName,
            reason: rec.reason,
          });
        }

        console.log(`[REBALANCE] ${rec.action.toUpperCase()} ${rec.campaignName} — ${details}`);
      }
    }

    console.log("[REBALANCE] Rebalanceamento concluído.");
  } catch (err) {
    console.error("[REBALANCE] Erro no rebalanceamento:", err);
  }
}

// ── Rebalance intra-campanha (nível ad set) ─────────────────

async function updateAdsetBudget(adsetId: string, newBudgetReais: number): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${adsetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daily_budget: Math.round(newBudgetReais * 100),
        access_token: metaToken,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[REBALANCE-ADSET] Erro ao atualizar budget do adset ${adsetId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[REBALANCE-ADSET] Erro ao atualizar budget do adset ${adsetId}:`, err);
    return false;
  }
}

interface AdsetWithMetrics7d {
  id: string;
  name: string;
  dailyBudget: number;
  metrics7d: { spend: number; sales: number; cpa: number };
}

async function getActiveAdsetsWithMetrics(campaignName: string): Promise<AdsetWithMetrics7d[]> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !metaAccountId) return [];

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = sevenDaysAgo.toISOString().split("T")[0];
    const until = now.toISOString().split("T")[0];

    const url = new URL(`${META_BASE}/${metaAccountId}/insights`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "adset_id,adset_name,spend,actions");
    url.searchParams.set("level", "adset");
    url.searchParams.set("time_range", JSON.stringify({ since, until }));
    url.searchParams.set("time_increment", "all_days");
    url.searchParams.set("filtering", JSON.stringify([{ field: "campaign.name", operator: "CONTAIN", value: campaignName }]));
    url.searchParams.set("limit", "200");

    const res = await fetch(url.toString());
    if (!res.ok) return [];

    const json = (await res.json()) as any;
    const rows: any[] = json.data ?? [];

    // Get active adset budgets
    const adsetsUrl = new URL(`${META_BASE}/${metaAccountId}/adsets`);
    adsetsUrl.searchParams.set("access_token", metaToken);
    adsetsUrl.searchParams.set("fields", "id,daily_budget,effective_status");
    adsetsUrl.searchParams.set("filtering", JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
    adsetsUrl.searchParams.set("limit", "200");

    const adsetsRes = await fetch(adsetsUrl.toString());
    const adsetsJson = (await adsetsRes.json()) as any;
    const adsetBudgets = new Map<string, number>();
    for (const adset of adsetsJson.data ?? []) {
      adsetBudgets.set(adset.id, adset.daily_budget ? parseFloat(adset.daily_budget) / 100 : 0);
    }

    const result: AdsetWithMetrics7d[] = [];
    for (const row of rows) {
      const adsetId = row.adset_id;
      if (!adsetBudgets.has(adsetId)) continue; // Only active adsets

      const spend = parseFloat(row.spend || "0");
      const actions: any[] = row.actions || [];
      const purchaseAction = actions.find(
        (a: any) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
      );
      const sales = purchaseAction ? parseInt(purchaseAction.value || "0") : 0;
      const cpa = sales > 0 ? spend / sales : spend > 0 ? 999 : 0;

      result.push({
        id: adsetId,
        name: row.adset_name || "",
        dailyBudget: adsetBudgets.get(adsetId) || 0,
        metrics7d: { spend, sales, cpa },
      });
    }

    return result;
  } catch (err) {
    console.error("[REBALANCE-ADSET] Erro ao buscar métricas de adsets:", err);
    return [];
  }
}

async function rebalanceWithinCampaign(campaign: { id: string; name: string; isInLearningPhase: boolean }): Promise<void> {
  // Ignorar campanhas em learning phase
  if (campaign.isInLearningPhase) return;

  // Ignorar campanhas ASC (Meta gerencia internamente)
  if (campaign.name.toUpperCase().includes("ASC") || campaign.name.toUpperCase().includes("ADVANTAGE")) return;

  const adsets = await getActiveAdsetsWithMetrics(campaign.name);

  // Precisa de pelo menos 2 ad sets ativos com dados de vendas
  const withData = adsets.filter(a => a.metrics7d.spend > 0 && a.metrics7d.sales > 0);
  if (withData.length < 2) return;

  // Calcular CPA médio da campanha
  const totalSpend = withData.reduce((sum, a) => sum + a.metrics7d.spend, 0);
  const totalSales = withData.reduce((sum, a) => sum + a.metrics7d.sales, 0);
  const avgCPA = totalSpend / totalSales;

  // Classificar: winners (CPA < 70% da média) e losers (CPA > 130% da média)
  const winners = withData.filter(a => a.metrics7d.cpa < avgCPA * 0.7);
  const losers = withData.filter(a => a.metrics7d.cpa > avgCPA * 1.3);

  if (winners.length === 0 || losers.length === 0) return;

  const notifyConfig = await prisma.automationConfig.findFirst({ orderBy: { updatedAt: "desc" } });
  const shouldNotify = notifyConfig?.notifyOnAutoAction ?? true;

  let totalMoved = 0;

  for (const loser of losers) {
    const lockCheck = await canAutomate('adset', loser.id, 'budget_rebalancer');
    if (!lockCheck.allowed) continue;

    const reduction = Math.round(loser.dailyBudget * 0.3);
    const newLoserBudget = loser.dailyBudget - reduction;

    // Não reduzir abaixo de R$20/dia (mínimo pra coletar dados)
    if (newLoserBudget < 20) continue;

    const success = await updateAdsetBudget(loser.id, newLoserBudget);
    if (!success) continue;

    await acquireLock('adset', loser.id, 'budget_rebalancer', 'budget_change', loser.dailyBudget, newLoserBudget);
    await logAction({
      action: "intra_campaign_rebalance",
      entityType: "adset",
      entityId: loser.id,
      entityName: loser.name,
      details: `Rebalance: CPA R$${loser.metrics7d.cpa.toFixed(0)} > média R$${avgCPA.toFixed(0)}. Budget R$${loser.dailyBudget} → R$${newLoserBudget} (-R$${reduction}).`,
      source: "automation",
    });

    // Distribuir a redução pros winners proporcionalmente
    const perWinner = Math.round(reduction / winners.length);
    for (const winner of winners) {
      const winnerLock = await canAutomate('adset', winner.id, 'budget_rebalancer');
      if (!winnerLock.allowed) continue;

      const newWinnerBudget = winner.dailyBudget + perWinner;
      const winSuccess = await updateAdsetBudget(winner.id, newWinnerBudget);
      if (!winSuccess) continue;

      await acquireLock('adset', winner.id, 'budget_rebalancer', 'budget_change', winner.dailyBudget, newWinnerBudget);
      await logAction({
        action: "intra_campaign_rebalance",
        entityType: "adset",
        entityId: winner.id,
        entityName: winner.name,
        details: `Rebalance: recebeu +R$${perWinner} de ad sets com CPA alto. Budget R$${winner.dailyBudget} → R$${newWinnerBudget}.`,
        source: "automation",
      });
    }

    totalMoved += reduction;
  }

  if (totalMoved > 0 && shouldNotify) {
    await sendNotification("auto_action", {
      action: "REBALANCE INTRA-CAMPANHA",
      adset: campaign.name,
      reason: `Moveu R$${totalMoved} de ${losers.length} ad set(s) com CPA alto para ${winners.length} vencedor(es). CPA médio: R$${avgCPA.toFixed(0)}.`,
    });
  }
}

export async function rebalanceWithinCampaigns(): Promise<void> {
  console.log("[REBALANCE-ADSET] Iniciando rebalance intra-campanha...");
  try {
    const campaigns = await prisma.campaign.findMany({ where: { status: "Ativa" } });
    for (const campaign of campaigns) {
      await rebalanceWithinCampaign(campaign);
    }
    console.log("[REBALANCE-ADSET] Rebalance intra-campanha concluído.");
  } catch (err) {
    console.error("[REBALANCE-ADSET] Erro:", err);
  }
}
