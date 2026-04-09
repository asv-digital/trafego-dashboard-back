import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";

const META_BASE = "https://graph.facebook.com/v19.0";

async function getAutomationConfig() {
  const config = await prisma.automationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  // Return defaults if no config exists
  return config || {
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
  };
}

async function pauseAdset(adsetId: string): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${adsetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "PAUSED",
        access_token: metaToken,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[AUTO] Erro ao pausar adset ${adsetId}:`, err);
    return false;
  }
}

async function updateAdsetBudget(adsetId: string, newBudgetReais: number): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${adsetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daily_budget: Math.round(newBudgetReais * 100), // Meta usa centavos
        access_token: metaToken,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[AUTO] Erro ao atualizar budget do adset ${adsetId}:`, err);
    return false;
  }
}

interface AdsetMetricDay {
  date: Date;
  spend: number;
  sales: number;
  cpa: number;
  revenue: number;
}

interface AdsetWithMetrics {
  id: string;
  name: string;
  campaignId: string;
  campaignName: string;
  isInLearningPhase: boolean;
  hoursActive: number;
  dailyBudget: number;
  totalSpend: number;
  sales: number;
  metrics: AdsetMetricDay[];
}

async function getActiveAdsetMetrics(): Promise<AdsetWithMetrics[]> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !metaAccountId) return [];

  try {
    // Get adset-level insights for last 7 days, broken by day
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const since = sevenDaysAgo.toISOString().split("T")[0];
    const until = now.toISOString().split("T")[0];

    const url = new URL(`${META_BASE}/${metaAccountId}/insights`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "adset_id,adset_name,campaign_id,campaign_name,spend,actions");
    url.searchParams.set("level", "adset");
    url.searchParams.set("time_range", JSON.stringify({ since, until }));
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("limit", "500");

    const res = await fetch(url.toString());
    if (!res.ok) return [];

    const json = (await res.json()) as any;
    const rows: any[] = json.data ?? [];

    // Group by adset
    const adsetMap = new Map<string, {
      name: string;
      campaignId: string;
      campaignName: string;
      dailyMetrics: AdsetMetricDay[];
    }>();

    for (const row of rows) {
      const adsetId = row.adset_id;
      if (!adsetMap.has(adsetId)) {
        adsetMap.set(adsetId, {
          name: row.adset_name || "",
          campaignId: row.campaign_id || "",
          campaignName: row.campaign_name || "",
          dailyMetrics: [],
        });
      }

      const spend = parseFloat(row.spend || "0");
      const actions: any[] = row.actions || [];
      const purchaseAction = actions.find(
        (a: any) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
      );
      const sales = purchaseAction ? parseInt(purchaseAction.value || "0") : 0;

      adsetMap.get(adsetId)!.dailyMetrics.push({
        date: new Date(row.date_start),
        spend,
        sales,
        cpa: sales > 0 ? spend / sales : 0,
        revenue: sales * 93.6,
      });
    }

    // Fetch campaigns from DB for learning phase info
    const campaignIds = [...new Set([...adsetMap.values()].map(a => a.campaignId))];
    const dbCampaigns = await prisma.campaign.findMany({
      where: { name: { in: [...new Set([...adsetMap.values()].map(a => a.campaignName))] } },
    });
    const campaignByName = new Map(dbCampaigns.map(c => [c.name, c]));

    // Fetch adset budgets from Meta
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

    const result: AdsetWithMetrics[] = [];

    for (const [adsetId, data] of adsetMap) {
      const dbCampaign = campaignByName.get(data.campaignName);
      const isInLearningPhase = dbCampaign?.isInLearningPhase ?? false;

      let hoursActive = 999;
      if (dbCampaign?.createdInMetaAt) {
        hoursActive = (Date.now() - dbCampaign.createdInMetaAt.getTime()) / (1000 * 60 * 60);
      }

      const totalSpend = data.dailyMetrics.reduce((s, m) => s + m.spend, 0);
      const totalSales = data.dailyMetrics.reduce((s, m) => s + m.sales, 0);

      // Only include adsets with active budgets
      if (!adsetBudgets.has(adsetId)) continue;

      result.push({
        id: adsetId,
        name: data.name,
        campaignId: data.campaignId,
        campaignName: data.campaignName,
        isInLearningPhase,
        hoursActive,
        dailyBudget: adsetBudgets.get(adsetId) || 0,
        totalSpend,
        sales: totalSales,
        metrics: data.dailyMetrics.sort((a, b) => a.date.getTime() - b.date.getTime()),
      });
    }

    return result;
  } catch (err) {
    console.error("[AUTO] Erro ao buscar métricas de adsets:", err);
    return [];
  }
}

export async function executeAutomations(): Promise<void> {
  const config = await getAutomationConfig();
  const adsets = await getActiveAdsetMetrics();

  console.log(`[AUTO] Avaliando ${adsets.length} adsets ativos...`);

  for (const adset of adsets) {
    // Respeitar fase de aprendizado (Passo 9)
    if (config.respectLearningPhase && adset.isInLearningPhase) {
      console.log(`[AUTO] Pulando ${adset.name} — em fase de aprendizado`);
      continue;
    }

    // REGRA 1: AUTO-PAUSE — Gasto > limite sem NENHUMA venda (ação imediata)
    if (config.autoPauseNoSales && adset.totalSpend > config.autoPauseSpendLimit && adset.sales === 0) {
      const success = await pauseAdset(adset.id);
      if (success) {
        await logAction({
          action: "auto_pause",
          entityType: "adset",
          entityId: adset.id,
          entityName: adset.name,
          details: `Auto-pause: R$${adset.totalSpend.toFixed(0)} gastos, 0 vendas. Limite: R$${config.autoPauseSpendLimit}.`,
          source: "automation",
        });
        if (config.notifyOnAutoAction) {
          await sendNotification("auto_action", {
            action: "PAUSADO",
            adset: adset.name,
            reason: `R$${adset.totalSpend.toFixed(0)} gastos sem nenhuma venda`,
          });
        }
        console.log(`[AUTO] PAUSADO ${adset.name} — R$${adset.totalSpend.toFixed(0)} sem vendas`);
      }
      continue;
    }

    // REGRA 2: AUTO-PAUSE — CPA acima do breakeven por X dias consecutivos
    if (config.autoPauseBreakeven) {
      const lastNDays = adset.metrics.slice(-config.breakevenMinDays);
      const allAboveBreakeven =
        lastNDays.length >= config.breakevenMinDays &&
        lastNDays.every((m) => m.sales > 0 && m.cpa > config.breakevenCPA);

      if (allAboveBreakeven) {
        const avgCPA = lastNDays.reduce((sum, m) => sum + m.cpa, 0) / lastNDays.length;
        const totalSpendPeriod = lastNDays.reduce((sum, m) => sum + m.spend, 0);
        const totalRevenuePeriod = lastNDays.reduce((sum, m) => sum + m.revenue, 0);
        const estimatedLoss = totalSpendPeriod - totalRevenuePeriod;

        const success = await pauseAdset(adset.id);
        if (success) {
          await logAction({
            action: "auto_pause_breakeven",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Auto-pause: CPA médio R$${avgCPA.toFixed(0)} > breakeven R$${config.breakevenCPA.toFixed(2)} por ${config.breakevenMinDays} dias. Prejuízo estimado: R$${Math.max(0, estimatedLoss).toFixed(0)}.`,
            source: "automation",
          });
          if (config.notifyOnAutoAction) {
            await sendNotification("auto_pause_breakeven", {
              adset: adset.name,
              avg_cpa: avgCPA.toFixed(0),
              breakeven: config.breakevenCPA.toFixed(2),
              days: config.breakevenMinDays,
              loss: Math.max(0, estimatedLoss).toFixed(0),
            });
          }
          console.log(`[AUTO] PAUSADO ${adset.name} — CPA R$${avgCPA.toFixed(0)} > breakeven por ${config.breakevenMinDays}d`);
        }
        continue;
      }
    }

    // REGRA 3: AUTO-SCALE — CPA abaixo do threshold por X dias consecutivos
    if (config.autoScaleWinners) {
      const lastNDays = adset.metrics.slice(-config.autoScaleMinDays);
      const allBelowThreshold =
        lastNDays.length >= config.autoScaleMinDays &&
        lastNDays.every((m) => m.sales > 0 && m.cpa > 0 && m.cpa < config.autoScaleCPAThreshold);

      if (allBelowThreshold && adset.dailyBudget < config.autoScaleMaxBudget) {
        const newBudget = Math.min(
          Math.round(adset.dailyBudget * (1 + config.autoScalePercent / 100)),
          config.autoScaleMaxBudget
        );

        const success = await updateAdsetBudget(adset.id, newBudget);
        if (success) {
          await logAction({
            action: "auto_scale",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Auto-scale: CPA <R$${config.autoScaleCPAThreshold} por ${config.autoScaleMinDays} dias. Budget R$${adset.dailyBudget} → R$${newBudget}. Teto: R$${config.autoScaleMaxBudget}.`,
            source: "automation",
          });
          if (config.notifyOnAutoAction) {
            await sendNotification("auto_action", {
              action: "ESCALADO",
              adset: adset.name,
              reason: `CPA <R$${config.autoScaleCPAThreshold} por ${config.autoScaleMinDays}d. Budget ${adset.dailyBudget} → ${newBudget}`,
            });
          }
          console.log(`[AUTO] ESCALADO ${adset.name} — Budget R$${adset.dailyBudget} → R$${newBudget}`);
        }
      }
    }
  }

  console.log("[AUTO] Automações concluídas.");
}
