import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { currentHourBRT, hourBRTFromDate } from "../lib/tz";
import { getAccountStatus } from "../lib/meta-account";

const META_BASE = "https://graph.facebook.com/v19.0";

async function getActiveABOAdsets(): Promise<Array<{ id: string; name: string; dailyBudget: number; campaignName: string }>> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !metaAccountId) return [];

  try {
    const url = new URL(`${META_BASE}/${metaAccountId}/adsets`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "id,name,daily_budget,effective_status,campaign_id");
    url.searchParams.set("filtering", JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
    url.searchParams.set("limit", "200");

    const res = await fetch(url.toString());
    if (!res.ok) return [];

    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const adsets = json.data ?? [];

    // Fetch campaigns to identify ASC
    const campaignsUrl = new URL(`${META_BASE}/${metaAccountId}/campaigns`);
    campaignsUrl.searchParams.set("access_token", metaToken);
    campaignsUrl.searchParams.set("fields", "id,name");
    campaignsUrl.searchParams.set("limit", "200");

    const campaignsRes = await fetch(campaignsUrl.toString());
    const campaignsJson = (await campaignsRes.json()) as { data?: Array<{ id: string; name: string }> };
    const campaignMap = new Map((campaignsJson.data ?? []).map((c) => [c.id, c.name]));

    // Filter out ASC campaigns — dayparting only applies to ABO
    return adsets
      .filter((a) => {
        const campaignName = campaignMap.get(String(a.campaign_id)) ?? "";
        const isASC = campaignName.toUpperCase().includes("ASC") || campaignName.toUpperCase().includes("ADVANTAGE");
        return !isASC;
      })
      .map((a) => ({
        id: String(a.id),
        name: String(a.name),
        dailyBudget: a.daily_budget ? parseFloat(String(a.daily_budget)) / 100 : 0,
        campaignName: campaignMap.get(String(a.campaign_id)) ?? "",
      }));
  } catch (err) {
    console.error("[DAYPART] Erro ao buscar adsets ABO:", err);
    return [];
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
        daily_budget: Math.round(newBudgetReais * 100),
        access_token: metaToken,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[DAYPART] Erro ao atualizar budget do adset ${adsetId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[DAYPART] Erro ao atualizar budget do adset ${adsetId}:`, err);
    return false;
  }
}

interface HourBucket {
  hour: number;
  count: number;
  revenue: number;
}

function identifyWindows(hours: HourBucket[]): { highWindows: number[]; lowWindows: number[] } {
  // Create 3-hour windows (8 windows total)
  const windows: Array<{ start: number; count: number; revenue: number }> = [];
  for (let start = 0; start < 24; start += 3) {
    let count = 0;
    let revenue = 0;
    for (let h = start; h < start + 3; h++) {
      const bucket = hours[h];
      if (bucket) {
        count += bucket.count;
        revenue += bucket.revenue;
      }
    }
    windows.push({ start, count, revenue });
  }

  // Sort by count descending for high windows
  const sorted = [...windows].sort((a, b) => b.count - a.count);
  const highWindows: number[] = [];
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    if (sorted[i].count > 0) {
      for (let h = sorted[i].start; h < sorted[i].start + 3; h++) {
        highWindows.push(h);
      }
    }
  }

  // Sort by count ascending for low windows (only include windows with 0 or very low conversions)
  const sortedAsc = [...windows].sort((a, b) => a.count - b.count);
  const lowWindows: number[] = [];
  for (let i = 0; i < Math.min(3, sortedAsc.length); i++) {
    // Only mark as low if truly underperforming
    if (sortedAsc[i].count <= 1) {
      for (let h = sortedAsc[i].start; h < sortedAsc[i].start + 3; h++) {
        lowWindows.push(h);
      }
    }
  }

  return { highWindows, lowWindows };
}

export async function applyDaypartingRules(): Promise<void> {
  console.log("[DAYPART] Verificando regras de dayparting...");

  // Pre-flight: conta ativa?
  const account = await getAccountStatus();
  if (!account.active) {
    console.log(`[DAYPART] Skipped — ad account ${account.status_key}`);
    return;
  }

  try {
    // 1. Get hourly sales distribution from last 14 days
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    const sales = await prisma.sale.findMany({
      where: {
        status: "approved",
        date: { gte: fourteenDaysAgo },
      },
      select: { date: true, amountNet: true },
    });

    if (sales.length < 10) {
      console.log("[DAYPART] Dados insuficientes (<10 vendas em 14d), pulando.");
      return;
    }

    // Build hourly distribution — horas em BRT (não UTC nem local do servidor).
    const hours: HourBucket[] = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, revenue: 0 }));
    for (const sale of sales) {
      const h = hourBRTFromDate(sale.date);
      hours[h].count++;
      hours[h].revenue += sale.amountNet;
    }

    // 2. Identify high/low performance windows
    const { highWindows, lowWindows } = identifyWindows(hours);
    const currentHour = currentHourBRT();

    // 3. Get active ABO adsets
    const adsets = await getActiveABOAdsets();
    if (adsets.length === 0) {
      console.log("[DAYPART] Nenhum adset ABO ativo.");
      return;
    }

    const isLowWindow = lowWindows.includes(currentHour);
    const isHighWindow = highWindows.includes(currentHour);

    if (isLowWindow) {
      // Reduce budget by 30% during low performance windows
      let actionsCount = 0;
      for (const adset of adsets) {
        if (adset.dailyBudget <= 0) continue;

        const lockCheck = await canAutomate('adset', adset.id, 'dayparting');
        if (!lockCheck.allowed) {
          console.log(`[DAYPART] Pulando ${adset.name} — ${lockCheck.reason}`);
          continue;
        }

        // O budget ATUAL já inclui mudanças do auto-executor (ex: auto-scale)
        const currentBudget = adset.dailyBudget;
        const reducedBudget = Math.round(currentBudget * 0.7);
        const success = await updateAdsetBudget(adset.id, reducedBudget);
        if (success) {
          actionsCount++;
          await acquireLock('adset', adset.id, 'dayparting', 'daypart_reduce', currentBudget, reducedBudget);
          await logAction({
            action: "dayparting_reduce",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Dayparting: janela de baixa conversão (${currentHour}h). Budget R$${currentBudget} → R$${reducedBudget} (-30%).`,
            source: "automation",
          });
          console.log(`[DAYPART] REDUZIDO ${adset.name}: R$${currentBudget} → R$${reducedBudget}`);
        }
      }

      // Notify only if reduction > 20% of total adsets
      if (actionsCount > adsets.length * 0.2) {
        await sendNotification("auto_action", {
          action: "DAYPARTING REDUÇÃO",
          adset: `${actionsCount} ad sets`,
          reason: `Janela de baixa conversão (${currentHour}h-${currentHour + 3}h). Budget reduzido em 30%.`,
        });
      }
    } else if (isHighWindow) {
      // Restore budgets using the lock's previousValue (budget ANTES da redução)
      let restoredCount = 0;
      for (const adset of adsets) {
        // Buscar lock de daypart_reduce para restaurar o budget correto
        const lock = await prisma.automationLock.findUnique({
          where: { entityType_entityId: { entityType: 'adset', entityId: adset.id } },
        });

        if (!lock || lock.lockedBy !== 'dayparting' || lock.action !== 'daypart_reduce' || !lock.previousValue) continue;

        const success = await updateAdsetBudget(adset.id, lock.previousValue);
        if (success) {
          restoredCount++;
          await acquireLock('adset', adset.id, 'dayparting', 'daypart_restore', adset.dailyBudget, lock.previousValue);
          await logAction({
            action: "dayparting_restore",
            entityType: "adset",
            entityId: adset.id,
            entityName: adset.name,
            details: `Dayparting: janela de alta conversão (${currentHour}h). Budget restaurado R$${adset.dailyBudget} → R$${lock.previousValue}.`,
            source: "automation",
          });
          console.log(`[DAYPART] RESTAURADO ${adset.name}: R$${adset.dailyBudget} → R$${lock.previousValue}`);
        }
      }

      if (restoredCount > 0) {
        console.log(`[DAYPART] ${restoredCount} ad sets restaurados para janela de alta conversão.`);
      }
    } else {
      console.log(`[DAYPART] Hora atual (${currentHour}h) em janela neutra, nenhuma ação.`);
    }

    console.log("[DAYPART] Dayparting concluído.");
  } catch (err) {
    console.error("[DAYPART] Erro no dayparting:", err);
  }
}
