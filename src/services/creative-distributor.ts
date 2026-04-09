import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";

const META_BASE = "https://graph.facebook.com/v19.0";

function getMetaToken() {
  return process.env.META_ACCESS_TOKEN || "";
}

function getMetaAccountId() {
  return process.env.META_AD_ACCOUNT_ID || "";
}

async function metaPost(endpoint: string, body: any) {
  const token = getMetaToken();
  const res = await fetch(`${META_BASE}/${endpoint}?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (data.error) throw new Error(data.error.message);
  return data;
}

export function detectCreativeFormat(width: number, height: number): string {
  if (!width || !height) return "unknown";
  const ratio = width / height;
  if (ratio < 0.6) return "vertical_9_16";
  if (ratio > 0.9 && ratio < 1.1) return "square_1_1";
  if (ratio > 0.7 && ratio < 0.9) return "portrait_4_5";
  if (ratio > 1.5) return "landscape_16_9";
  return "portrait_4_5";
}

interface DistributeResult {
  creativeId: string;
  action: string;
  format: string;
  adsetsCount: number;
  ascCount: number;
}

export async function distributeCreative(creativeId: string, creativeName: string): Promise<DistributeResult> {
  const token = getMetaToken();
  const accountId = getMetaAccountId();

  // 1. Get active adsets from Meta
  const adsetsRes = await fetch(
    `${META_BASE}/${accountId}/adsets?fields=id,name,campaign_id,effective_status&filtering=${encodeURIComponent(JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]))}&limit=200&access_token=${token}`
  );
  const adsetsData = (await adsetsRes.json()) as any;
  const activeAdsets: any[] = adsetsData.data ?? [];

  // 2. Get campaigns to identify ASC
  const campaignsRes = await fetch(
    `${META_BASE}/${accountId}/campaigns?fields=id,name,objective,buying_type&filtering=${encodeURIComponent(JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] }]))}&limit=100&access_token=${token}`
  );
  const campaignsData = (await campaignsRes.json()) as any;
  const allCampaigns: any[] = campaignsData.data ?? [];

  const ascCampaignIds = new Set(
    allCampaigns
      .filter((c: any) => (c.name || "").toUpperCase().includes("ASC") || (c.name || "").toUpperCase().includes("ADVANTAGE"))
      .map((c: any) => c.id)
  );

  // Separate manual adsets from ASC
  const manualAdsets = activeAdsets.filter((a) => !ascCampaignIds.has(a.campaign_id));
  const ascAdsets = activeAdsets.filter((a) => ascCampaignIds.has(a.campaign_id));

  // 3. Check for exhausted creatives to replace
  const dbCreatives = await prisma.creative.findMany({
    where: { status: "Ativo" },
    include: { campaign: true },
  });

  const exhausted = dbCreatives.filter((c) => {
    if (!c.cpa) return false;
    const daysActive = Math.floor((Date.now() - c.createdAt.getTime()) / 86400000);
    return c.cpa > 70 || daysActive > 25;
  });

  let action = "";
  let adsCreated = 0;

  // 4. Create ads in manual adsets
  for (const adset of manualAdsets) {
    try {
      await metaPost(`${accountId}/ads`, {
        adset_id: adset.id,
        name: `${creativeName} | ${adset.name}`,
        creative: { creative_id: creativeId },
        status: "ACTIVE",
      });
      adsCreated++;
    } catch (err) {
      console.error(`[DISTRIBUTE] Erro ao criar ad no adset ${adset.name}:`, err);
    }
  }

  // 5. Create ads in ASC adsets
  let ascCount = 0;
  for (const adset of ascAdsets) {
    try {
      await metaPost(`${accountId}/ads`, {
        adset_id: adset.id,
        name: `${creativeName} | ASC`,
        creative: { creative_id: creativeId },
        status: "ACTIVE",
      });
      ascCount++;
    } catch (err) {
      console.error(`[DISTRIBUTE] Erro ao criar ad ASC:`, err);
    }
  }

  if (exhausted.length > 0) {
    const replaced = exhausted[0];
    action = `Criativo distribuído em ${adsCreated} ad sets + ${ascCount} ASC. Substituindo criativo esgotado "${replaced.name}".`;

    // Mark old creative as paused in DB
    await prisma.creative.update({
      where: { id: replaced.id },
      data: { status: "Pausado" },
    });
  } else {
    action = `Criativo distribuído em ${adsCreated} ad sets + ${ascCount} ASC.`;
  }

  await logAction({
    action: "distribute_creative",
    entityType: "creative",
    entityId: creativeId,
    entityName: creativeName,
    details: action,
    source: "automation",
  });

  await sendNotification("creative_distributed", { action });

  console.log(`[DISTRIBUTE] ${action}`);

  return {
    creativeId,
    action,
    format: "auto",
    adsetsCount: adsCreated,
    ascCount,
  };
}
