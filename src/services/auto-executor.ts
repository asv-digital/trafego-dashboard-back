import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";
import { NET_PER_SALE } from "../config/constants";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { canIncreaseBudget, getCurrentAllocation } from "./budget-guard";

const META_BASE = "https://graph.facebook.com/v19.0";

// Ponto 9: Verificar se CPA alto é causado por CPM do mercado
async function isCPMSpike(): Promise<{ isSpike: boolean; variation: number; message: string }> {
  try {
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const trend = await prisma.cPMTrend.findUnique({ where: { date: todayDate } });

    const thirtyDaysAgo = new Date(todayDate);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const last30d = await prisma.cPMTrend.findMany({
      where: { date: { gte: thirtyDaysAgo, lt: todayDate } },
    });

    if (!trend || last30d.length < 7) return { isSpike: false, variation: 0, message: "Dados insuficientes" };

    const avg30dCPM = last30d.reduce((sum, d) => sum + d.avgCPM, 0) / last30d.length;
    const variation = ((trend.avgCPM - avg30dCPM) / avg30dCPM) * 100;

    // Se CPM subiu >20% MAS CTR se manteve (±10%), é o mercado
    const avg30dCTR = last30d.reduce((sum, d) => sum + d.avgCTR, 0) / last30d.length;
    const ctrVariation = avg30dCTR > 0 ? Math.abs((trend.avgCTR - avg30dCTR) / avg30dCTR) * 100 : 0;

    const isMarketSpike = variation > 20 && ctrVariation < 10;

    return {
      isSpike: isMarketSpike,
      variation: Math.round(variation),
      message: isMarketSpike
        ? `CPM +${Math.round(variation)}% vs media 30d, mas CTR estavel. Provavel aumento de competicao no leilao.`
        : `CPM ${variation > 0 ? "+" : ""}${Math.round(variation)}% vs media 30d.`,
    };
  } catch {
    return { isSpike: false, variation: 0, message: "Erro ao verificar CPM" };
  }
}

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
    autoPauseFrequency: true,
    frequencyLimitProspection: 3.0,
    frequencyLimitRemarketing: 6.0,
    budgetCapProspection: 250,
    budgetCapRemarketing: 200,
    budgetCapASC: 150,
    budgetFloorProspection: 100,
    budgetFloorRemarketing: 100,
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

  // Whitelist: só considera campanhas registradas pelo Campaign Builder.
  // Protege contas Meta compartilhadas com outros produtos — o agente nunca
  // toca em adsets de campanhas que ele mesmo não criou.
  const trackedCampaigns = await prisma.campaign.findMany({
    where: { metaCampaignId: { not: null } },
  });
  if (trackedCampaigns.length === 0) return [];
  const trackedByMetaId = new Map(trackedCampaigns.map(c => [c.metaCampaignId!, c]));

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

    // Group by adset — skip rows whose campaign is not tracked.
    const adsetMap = new Map<string, {
      name: string;
      campaignId: string;
      campaignName: string;
      dailyMetrics: AdsetMetricDay[];
    }>();

    for (const row of rows) {
      const campaignId = row.campaign_id || "";
      if (!trackedByMetaId.has(campaignId)) continue;

      const adsetId = row.adset_id;
      if (!adsetMap.has(adsetId)) {
        adsetMap.set(adsetId, {
          name: row.adset_name || "",
          campaignId,
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

    if (adsetMap.size === 0) return [];

    // Fetch adset budgets from Meta (filtered by tracked campaigns)
    const adsetsUrl = new URL(`${META_BASE}/${metaAccountId}/adsets`);
    adsetsUrl.searchParams.set("access_token", metaToken);
    adsetsUrl.searchParams.set("fields", "id,daily_budget,effective_status,campaign_id");
    adsetsUrl.searchParams.set("filtering", JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
    adsetsUrl.searchParams.set("limit", "200");

    const adsetsRes = await fetch(adsetsUrl.toString());
    const adsetsJson = (await adsetsRes.json()) as any;
    const adsetBudgets = new Map<string, number>();
    for (const adset of adsetsJson.data ?? []) {
      if (!trackedByMetaId.has(adset.campaign_id || "")) continue;
      adsetBudgets.set(adset.id, adset.daily_budget ? parseFloat(adset.daily_budget) / 100 : 0);
    }

    const result: AdsetWithMetrics[] = [];

    for (const [adsetId, data] of adsetMap) {
      const dbCampaign = trackedByMetaId.get(data.campaignId);
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
      // Ponto 3: Verificar boletos/pix pendentes antes de pausar
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const pendingSales = await prisma.sale.count({
        where: {
          status: { startsWith: "pending" },
          createdAt: { gte: threeDaysAgo },
          OR: [
            { metaAdsetId: adset.id },
            { metaCampaignId: adset.campaignId },
          ],
        },
      });

      if (pendingSales > 0) {
        // Tem boletos pendentes — verificar se já esperou 48h
        const oldestPending = await prisma.sale.findFirst({
          where: {
            status: { startsWith: "pending" },
            OR: [{ metaAdsetId: adset.id }, { metaCampaignId: adset.campaignId }],
          },
          orderBy: { createdAt: "asc" },
        });

        const hoursWaiting = oldestPending
          ? (Date.now() - oldestPending.createdAt.getTime()) / (1000 * 60 * 60)
          : 0;

        if (hoursWaiting < 48) {
          await logAction({
            action: "pause_delayed_pending_sales",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Gasto R$${adset.totalSpend.toFixed(0)} sem vendas aprovadas, mas ${pendingSales} boleto(s) pendente(s). Aguardando 48h.`,
            source: "automation",
          });
          if (config.notifyOnAutoAction) {
            await sendNotification("auto_action", {
              action: "AGUARDANDO BOLETOS",
              adset: adset.name,
              reason: `R$${adset.totalSpend.toFixed(0)} sem vendas, mas ${pendingSales} boleto(s) pendente(s). Aguardando conversao (max 48h).`,
            });
          }
          console.log(`[AUTO] AGUARDANDO ${adset.name} — ${pendingSales} boleto(s) pendente(s)`);
          continue;
        }
        // Se já passou 48h, cai no fluxo de pausa normal abaixo
      }

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
          details: `Auto-pause: R$${adset.totalSpend.toFixed(0)} gastos, 0 vendas${pendingSales > 0 ? ` (${pendingSales} boletos vencidos)` : ""}. Limite: R$${config.autoPauseSpendLimit}.`,
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
        // Ponto 9: Verificar se é spike de CPM do mercado antes de pausar
        const cpmCheck = await isCPMSpike();
        if (cpmCheck.isSpike) {
          await logAction({
            action: "breakeven_skip_cpm_spike",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `CPA acima do breakeven MAS ${cpmCheck.message} Aguardando normalizacao do mercado.`,
            source: "automation",
          });
          if (config.notifyOnAutoAction) {
            await sendNotification("auto_action", {
              action: "AGUARDANDO (CPM DO MERCADO)",
              adset: adset.name,
              reason: cpmCheck.message,
            });
          }
          console.log(`[AUTO] SKIP breakeven ${adset.name} — ${cpmCheck.message}`);
          continue;
        }

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

        const desiredNewBudget = Math.min(
          Math.round(adset.dailyBudget * (1 + config.autoScalePercent / 100)),
          config.autoScaleMaxBudget
        );
        const desiredIncrement = desiredNewBudget - adset.dailyBudget;

        // Ponto 4: Verificar budget total + teto por tipo
        const budgetCheck = await canIncreaseBudget(adset.campaignName, desiredIncrement);
        if (!budgetCheck.allowed) {
          await logAction({
            action: "scale_blocked_budget",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Escala bloqueada: ${budgetCheck.reason}`,
            source: "automation",
          });
          console.log(`[AUTO] SCALE BLOQUEADO ${adset.name} — ${budgetCheck.reason}`);
          continue;
        }

        const newBudget = budgetCheck.maxIncrease < desiredIncrement
          ? adset.dailyBudget + budgetCheck.maxIncrease
          : desiredNewBudget;
        const isPartial = budgetCheck.maxIncrease < desiredIncrement;

        const success = await updateAdsetBudget(adset.id, newBudget);
        if (success) {
          await acquireLock('adset', adset.id, 'auto_executor', 'scale', adset.dailyBudget, newBudget);
          await logAction({
            action: isPartial ? "auto_scale_partial" : "auto_scale",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Auto-scale${isPartial ? " PARCIAL" : ""}: CPA <R$${config.autoScaleCPAThreshold} por ${config.autoScaleMinDays} dias. Budget R$${adset.dailyBudget} → R$${newBudget}.${isPartial ? ` ${budgetCheck.reason}` : ""}`,
            source: "automation",
          });
          if (config.notifyOnAutoAction) {
            await sendNotification("auto_action", {
              action: isPartial ? "ESCALA PARCIAL" : "ESCALADO",
              adset: adset.name,
              reason: `CPA <R$${config.autoScaleCPAThreshold} por ${config.autoScaleMinDays}d. Budget ${adset.dailyBudget} → ${newBudget}${isPartial ? " (limitado pelo budget total)" : ""}`,
            });
          }
          console.log(`[AUTO] ${isPartial ? "ESCALA PARCIAL" : "ESCALADO"} ${adset.name} — Budget R$${adset.dailyBudget} → R$${newBudget}`);
        }
      }
    }

    // REGRA 4: AUTO-PAUSE FREQUÊNCIA — Audiência saturada (só prospecção)
    if (config.autoPauseFrequency !== false) {
      const isRemarketing = adset.campaignName?.toUpperCase().includes("RMK") ||
                            adset.campaignName?.toUpperCase().includes("REMARKETING");
      const freqLimit = isRemarketing
        ? (config.frequencyLimitRemarketing ?? 6.0)
        : (config.frequencyLimitProspection ?? 3.0);

      // Pega frequência dos últimos 3 dias
      const recentMetrics = adset.metrics.slice(-3);
      if (recentMetrics.length >= 2) {
        const frequencies = recentMetrics.filter((m) => m.date && adset.metrics.indexOf(m) >= adset.metrics.length - 3);
        const avgFrequency = frequencies.length > 0
          ? frequencies.reduce((sum, m) => {
              // Frequência vem do Meta, estimamos pelo total
              const freq = adset.totalSpend > 0 && adset.metrics.length > 0
                ? adset.metrics[adset.metrics.length - 1]?.spend / (adset.dailyBudget || 1)
                : 0;
              return sum + freq;
            }, 0) / frequencies.length
          : 0;

        // Usar a frequência diretamente dos dados do Meta que já temos
        // O campo frequency já é coletado pelo getActiveAdsetMetrics
        const metaFrequency = recentMetrics.length > 0
          ? recentMetrics.reduce((max, m) => Math.max(max, 0), 0)
          : 0;

        // Busca frequência real via Meta API para este adset
        const metaToken = process.env.META_ACCESS_TOKEN;
        if (metaToken) {
          try {
            const freqUrl = new URL(`${META_BASE}/${adset.id}/insights`);
            freqUrl.searchParams.set("access_token", metaToken);
            freqUrl.searchParams.set("fields", "frequency");
            freqUrl.searchParams.set("date_preset", "last_3d");
            const freqRes = await fetch(freqUrl.toString());
            if (freqRes.ok) {
              const freqJson = (await freqRes.json()) as any;
              const freq = parseFloat(freqJson.data?.[0]?.frequency || "0");

              if (freq > freqLimit) {
                const recentSales = recentMetrics.reduce((sum, m) => sum + m.sales, 0);

                if (recentSales > 0 && freq < freqLimit + 1.5) {
                  // Tem vendas mas frequência subindo — só alerta (não pausa RMK)
                  await logAction({
                    action: "frequency_warning",
                    entityType: "adset",
                    entityId: adset.id,
                    entityName: adset.name,
                    details: `Frequencia ${freq.toFixed(1)} > limite ${freqLimit}. Tem ${recentSales} vendas, monitorando.`,
                    source: "automation",
                  });
                  if (config.notifyOnAutoAction) {
                    await sendNotification("auto_action", {
                      action: "FREQUENCIA SUBINDO",
                      adset: adset.name,
                      reason: `Frequencia ${freq.toFixed(1)} (limite: ${freqLimit}). Tem ${recentSales} vendas, monitorando.`,
                    });
                  }
                } else if (!isRemarketing) {
                  // Prospecção sem vendas com frequência alta — pausa
                  const freqLock = await canAutomate('adset', adset.id, 'auto_executor');
                  if (freqLock.allowed) {
                    const success = await pauseAdset(adset.id);
                    if (success) {
                      await acquireLock('adset', adset.id, 'auto_executor', 'pause', adset.dailyBudget, 0);
                      await logAction({
                        action: "frequency_pause",
                        entityType: "adset",
                        entityId: adset.id,
                        entityName: adset.name,
                        details: `Pausado por frequencia ${freq.toFixed(1)} > ${freqLimit}. Vendas 3d: ${recentSales}. Audiencia saturada.`,
                        source: "automation",
                      });
                      if (config.notifyOnAutoAction) {
                        await sendNotification("auto_action", {
                          action: "PAUSA POR FREQUENCIA",
                          adset: adset.name,
                          reason: `Frequencia ${freq.toFixed(1)} > ${freqLimit}. Vendas 3d: ${recentSales}. Audiencia saturada.`,
                        });
                      }
                      console.log(`[AUTO] PAUSA FREQUENCIA ${adset.name} — freq ${freq.toFixed(1)}`);
                    }
                  }
                }
              }
            }
          } catch (freqErr) {
            // Silently skip frequency check on error
          }
        }
      }
    }
  }

  console.log("[AUTO] Automações concluídas.");
}
