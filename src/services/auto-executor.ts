import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";
import { NET_PER_SALE } from "../config/constants";
import { canAutomate, acquireLock } from "./automation-coordinator";

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

async function scaleCampaignBudget(campaignId: string, newBudgetReais: number): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daily_budget: Math.round(newBudgetReais * 100),
        access_token: metaToken,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[AUTO] Erro ao escalar campanha ${campaignId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[AUTO] Erro ao escalar campanha ${campaignId}:`, err);
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
      console.error(`[AUTO] Erro ao pausar campanha ${campaignId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[AUTO] Erro ao pausar campanha ${campaignId}:`, err);
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
  isASC: boolean;
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
        revenue: sales * NET_PER_SALE,
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
      const isASC = data.campaignName.toUpperCase().includes("ASC") || data.campaignName.toUpperCase().includes("ADVANTAGE");

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
        isASC,
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

  // REGRA 0: PROTEÇÃO DE BUDGET DIÁRIO GLOBAL
  const dailyBudgetTarget = Number(process.env.DAILY_BUDGET_TARGET) || 500;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const todayMetrics = await prisma.metricEntry.findMany({
    where: { date: { gte: todayStart, lte: todayEnd } },
  });
  const todaySpend = todayMetrics.reduce((s, m) => s + m.investment, 0);

  if (todaySpend >= dailyBudgetTarget) {
    console.log(`[AUTO] BUDGET DIÁRIO ATINGIDO: R$${todaySpend.toFixed(0)} >= R$${dailyBudgetTarget}. Pausando todos os ad sets.`);
    let pausedCount = 0;
    for (const adset of adsets) {
      const success = await pauseAdset(adset.id);
      if (success) pausedCount++;
    }

    await logAction({
      action: "emergency_budget_pause",
      entityType: "account",
      entityId: "global",
      entityName: "Budget diário global",
      details: `Gasto do dia R$${todaySpend.toFixed(0)} atingiu limite de R$${dailyBudgetTarget}. ${pausedCount} ad sets pausados.`,
      source: "automation",
    });

    await sendNotification("alert_critical", {
      type: "BUDGET DIÁRIO ATINGIDO",
      detail: `Gasto: R$${todaySpend.toFixed(0)} / Limite: R$${dailyBudgetTarget}`,
      action: `${pausedCount} ad sets pausados automaticamente`,
    });

    return; // Não executar mais nenhuma automação
  }

  for (const adset of adsets) {
    // Respeitar fase de aprendizado (Passo 9)
    if (config.respectLearningPhase && adset.isInLearningPhase) {
      console.log(`[AUTO] Pulando ${adset.name} — em fase de aprendizado`);
      continue;
    }

    // ASC: pular regras de adset, aplicar apenas na campanha
    if (adset.isASC) {
      // REGRA ASC-PAUSE: gasto > limite sem vendas → pausar campanha
      if (config.autoPauseNoSales && adset.totalSpend > config.autoPauseSpendLimit && adset.sales === 0) {
        const lockCheck = await canAutomate('campaign', adset.campaignId, 'auto_executor');
        if (!lockCheck.allowed) {
          console.log(`[AUTO] Pulando ASC ${adset.campaignName} — ${lockCheck.reason}`);
          continue;
        }

        const success = await pauseCampaign(adset.campaignId);
        if (success) {
          await acquireLock('campaign', adset.campaignId, 'auto_executor', 'pause', adset.dailyBudget, 0);
          await logAction({
            action: "auto_pause",
            entityType: "campaign",
            entityId: adset.campaignId,
            entityName: `${adset.campaignName} (ASC)`,
            details: `Auto-pause ASC: R$${adset.totalSpend.toFixed(0)} gastos, 0 vendas. Limite: R$${config.autoPauseSpendLimit}.`,
            source: "automation",
          });
          if (config.notifyOnAutoAction) {
            await sendNotification("auto_action", {
              action: "PAUSADO (ASC campanha)",
              adset: adset.campaignName,
              reason: `R$${adset.totalSpend.toFixed(0)} gastos sem nenhuma venda`,
            });
          }
          console.log(`[AUTO] PAUSADO ASC campanha ${adset.campaignName}`);
        }
        continue;
      }

      // REGRA ASC-SCALE: CPA bom → escalar budget da campanha
      if (config.autoScaleWinners) {
        const lastNDays = adset.metrics.slice(-config.autoScaleMinDays);
        const allBelowThreshold =
          lastNDays.length >= config.autoScaleMinDays &&
          lastNDays.every((m) => m.sales > 0 && m.cpa > 0 && m.cpa < config.autoScaleCPAThreshold);

        if (allBelowThreshold && adset.dailyBudget < config.autoScaleMaxBudget) {
          const lockCheck = await canAutomate('campaign', adset.campaignId, 'auto_executor');
          if (!lockCheck.allowed) {
            console.log(`[AUTO] Pulando scale ASC ${adset.campaignName} — ${lockCheck.reason}`);
            continue;
          }

          const newBudget = Math.min(
            Math.round(adset.dailyBudget * (1 + config.autoScalePercent / 100)),
            config.autoScaleMaxBudget
          );

          const success = await scaleCampaignBudget(adset.campaignId, newBudget);
          if (success) {
            await acquireLock('campaign', adset.campaignId, 'auto_executor', 'scale', adset.dailyBudget, newBudget);
            await logAction({
              action: "auto_scale",
              entityType: "campaign",
              entityId: adset.campaignId,
              entityName: `${adset.campaignName} (ASC)`,
              details: `Auto-scale ASC: CPA <R$${config.autoScaleCPAThreshold} por ${config.autoScaleMinDays} dias. Budget campanha R$${adset.dailyBudget} → R$${newBudget}.`,
              source: "automation",
            });
            if (config.notifyOnAutoAction) {
              await sendNotification("auto_action", {
                action: "ESCALADO (ASC campanha)",
                adset: adset.campaignName,
                reason: `CPA <R$${config.autoScaleCPAThreshold} por ${config.autoScaleMinDays}d. Budget campanha ${adset.dailyBudget} → ${newBudget}`,
              });
            }
            console.log(`[AUTO] ESCALADO ASC campanha ${adset.campaignName} — Budget R$${adset.dailyBudget} → R$${newBudget}`);
          }
        }
      }
      continue;
    }

    // REGRA 1: AUTO-PAUSE — Gasto > limite sem NENHUMA venda (ação imediata)
    if (config.autoPauseNoSales && adset.totalSpend > config.autoPauseSpendLimit && adset.sales === 0) {
      const lockCheck = await canAutomate('adset', adset.id, 'auto_executor');
      if (!lockCheck.allowed) {
        console.log(`[AUTO] Pulando ${adset.name} — ${lockCheck.reason}`);
        continue;
      }

      const success = await pauseAdset(adset.id);
      if (success) {
        await acquireLock('adset', adset.id, 'auto_executor', 'pause', adset.dailyBudget, 0);
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
        const lockCheck = await canAutomate('adset', adset.id, 'auto_executor');
        if (!lockCheck.allowed) {
          console.log(`[AUTO] Pulando breakeven ${adset.name} — ${lockCheck.reason}`);
          continue;
        }

        const avgCPA = lastNDays.reduce((sum, m) => sum + m.cpa, 0) / lastNDays.length;
        const totalSpendPeriod = lastNDays.reduce((sum, m) => sum + m.spend, 0);
        const totalRevenuePeriod = lastNDays.reduce((sum, m) => sum + m.revenue, 0);
        const estimatedLoss = totalSpendPeriod - totalRevenuePeriod;

        const success = await pauseAdset(adset.id);
        if (success) {
          await acquireLock('adset', adset.id, 'auto_executor', 'pause', adset.dailyBudget, 0);
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
        const lockCheck = await canAutomate('adset', adset.id, 'auto_executor');
        if (!lockCheck.allowed) {
          console.log(`[AUTO] Pulando scale ${adset.name} — ${lockCheck.reason}`);
          continue;
        }

        const newBudget = Math.min(
          Math.round(adset.dailyBudget * (1 + config.autoScalePercent / 100)),
          config.autoScaleMaxBudget
        );

        const success = await updateAdsetBudget(adset.id, newBudget);
        if (success) {
          await acquireLock('adset', adset.id, 'auto_executor', 'scale', adset.dailyBudget, newBudget);
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
