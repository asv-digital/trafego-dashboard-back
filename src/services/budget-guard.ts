import prisma from "../prisma";

const META_BASE = "https://graph.facebook.com/v19.0";
const DAILY_BUDGET_TARGET = parseFloat(process.env.DAILY_BUDGET_TARGET || "500");
const BUDGET_SAFETY_MARGIN = 0.95; // 5% margem

export interface BudgetAllocation {
  prospection: number;
  remarketing: number;
  asc: number;
  total: number;
  reserve: number;
}

export function classifyCampaign(name: string): "prospection" | "remarketing" | "asc" | "other" {
  const upper = (name || "").toUpperCase();
  if (upper.includes("RMK") || upper.includes("REMARKETING") || upper.includes("RETARGETING"))
    return "remarketing";
  if (upper.includes("ASC") || upper.includes("ADVANTAGE"))
    return "asc";
  if (upper.includes("PROSP") || upper.includes("PROSPECCAO") || upper.includes("BROAD") || upper.includes("LAL"))
    return "prospection";
  return "other";
}

export async function getActiveAdsetBudgets(): Promise<Array<{ id: string; name: string; campaignName: string; dailyBudget: number }>> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !metaAccountId) return [];

  try {
    const url = new URL(`${META_BASE}/${metaAccountId}/adsets`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "id,name,daily_budget,campaign_id,effective_status");
    url.searchParams.set("filtering", JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
    url.searchParams.set("limit", "200");
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const adsets = json.data ?? [];

    // Get campaign names
    const campaignsUrl = new URL(`${META_BASE}/${metaAccountId}/campaigns`);
    campaignsUrl.searchParams.set("access_token", metaToken);
    campaignsUrl.searchParams.set("fields", "id,name");
    campaignsUrl.searchParams.set("limit", "200");
    const campRes = await fetch(campaignsUrl.toString());
    const campJson = (await campRes.json()) as any;
    const campaignMap = new Map((campJson.data ?? []).map((c: any) => [c.id, c.name]));

    return adsets.map((a: any) => ({
      id: a.id,
      name: a.name || "",
      campaignName: campaignMap.get(a.campaign_id) || "",
      dailyBudget: a.daily_budget ? parseFloat(a.daily_budget) / 100 : 0,
    }));
  } catch {
    return [];
  }
}

export async function getCurrentAllocation(): Promise<BudgetAllocation> {
  const adsets = await getActiveAdsetBudgets();
  const allocation: BudgetAllocation = { prospection: 0, remarketing: 0, asc: 0, total: 0, reserve: 0 };

  for (const adset of adsets) {
    const type = classifyCampaign(adset.campaignName);
    switch (type) {
      case "remarketing": allocation.remarketing += adset.dailyBudget; break;
      case "asc": allocation.asc += adset.dailyBudget; break;
      default: allocation.prospection += adset.dailyBudget; break;
    }
  }

  allocation.total = allocation.prospection + allocation.remarketing + allocation.asc;
  allocation.reserve = Math.max(0, DAILY_BUDGET_TARGET - allocation.total);
  return allocation;
}

export async function getConfig() {
  const config = await prisma.automationConfig.findFirst({ orderBy: { updatedAt: "desc" } });
  return {
    capProspection: config?.budgetCapProspection ?? 250,
    capRemarketing: config?.budgetCapRemarketing ?? 200,
    capASC: config?.budgetCapASC ?? 150,
    floorProspection: config?.budgetFloorProspection ?? 100,
    floorRemarketing: config?.budgetFloorRemarketing ?? 100,
  };
}

export async function canIncreaseBudget(
  campaignName: string,
  increaseAmount: number
): Promise<{ allowed: boolean; maxIncrease: number; reason?: string }> {
  const allocation = await getCurrentAllocation();
  const caps = await getConfig();
  const type = classifyCampaign(campaignName);

  const currentForType = type === "remarketing" ? allocation.remarketing : type === "asc" ? allocation.asc : allocation.prospection;
  const capForType = type === "remarketing" ? caps.capRemarketing : type === "asc" ? caps.capASC : caps.capProspection;

  // Check type cap
  const availableForType = Math.max(0, capForType - currentForType);

  // Check total budget
  const maxTotal = DAILY_BUDGET_TARGET * BUDGET_SAFETY_MARGIN;
  const availableTotal = Math.max(0, maxTotal - allocation.total);

  const available = Math.min(availableForType, availableTotal);

  if (available <= 0) {
    return {
      allowed: false,
      maxIncrease: 0,
      reason: availableForType <= 0
        ? `Teto de ${type} atingido: R$${currentForType.toFixed(0)}/R$${capForType}`
        : `Budget total atingido: R$${allocation.total.toFixed(0)}/R$${DAILY_BUDGET_TARGET}`,
    };
  }

  if (increaseAmount <= available) {
    return { allowed: true, maxIncrease: increaseAmount };
  }

  return {
    allowed: true,
    maxIncrease: available,
    reason: `Limitado: R$${available.toFixed(0)} disponivel (teto ${type}: R$${capForType}, total: R$${DAILY_BUDGET_TARGET})`,
  };
}

export async function canDecreaseBudget(
  campaignName: string,
  decreaseAmount: number
): Promise<{ allowed: boolean; maxDecrease: number; reason?: string }> {
  const allocation = await getCurrentAllocation();
  const { floorProspection, floorRemarketing } = await getConfig();
  const type = classifyCampaign(campaignName);

  const currentForType = type === "remarketing" ? allocation.remarketing : type === "asc" ? allocation.asc : allocation.prospection;
  const floorForType = type === "remarketing" ? floorRemarketing : type === "asc" ? 0 : floorProspection;

  const canRemove = Math.max(0, currentForType - floorForType);

  if (canRemove <= 0) {
    return {
      allowed: false,
      maxDecrease: 0,
      reason: `${type} ja esta no minimo: R$${currentForType.toFixed(0)}/R$${floorForType}`,
    };
  }

  return {
    allowed: true,
    maxDecrease: Math.min(decreaseAmount, canRemove),
  };
}
