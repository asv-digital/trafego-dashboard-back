import prisma from "../prisma";
import { logAction } from "../routes/actions";
import { sendNotification } from "./whatsapp-notifier";

const META_BASE = "https://graph.facebook.com/v19.0";

const LOOKALIKE_MILESTONES = [
  { buyers: 100, percentages: [1] },
  { buyers: 200, percentages: [1, 2] },
  { buyers: 500, percentages: [1, 2, 3] },
  { buyers: 1000, percentages: [1, 2, 3, 5] },
];

export async function checkLookalikeCreation(): Promise<void> {
  const sourceAudienceId = process.env.META_AUDIENCE_BUYERS_ID;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  const metaToken = process.env.META_ACCESS_TOKEN;

  if (!sourceAudienceId || !adAccountId || !metaToken) {
    console.log("[AUDIENCE] Env vars META_AUDIENCE_BUYERS_ID ou META_AD_ACCOUNT_ID nao configuradas.");
    return;
  }

  const buyerCount = await prisma.sale.count({ where: { status: "approved" } });
  console.log(`[AUDIENCE] ${buyerCount} compradores. Verificando milestones...`);

  const currentMilestone = LOOKALIKE_MILESTONES.filter((m) => buyerCount >= m.buyers).pop();
  if (!currentMilestone) {
    console.log(`[AUDIENCE] Menos de 100 compradores. Aguardando.`);
    return;
  }

  const existingLALs = await prisma.lookalikeAudience.findMany();

  for (const percentage of currentMilestone.percentages) {
    const alreadyExists = existingLALs.find(
      (l) => l.percentage === percentage && l.buyerCountAtCreation >= currentMilestone.buyers * 0.8
    );
    if (alreadyExists) continue;

    try {
      const lalName = `LAL ${percentage}% Buyers ${buyerCount}+ (auto)`;

      const res = await fetch(`${META_BASE}/${adAccountId}/customaudiences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lalName,
          subtype: "LOOKALIKE",
          origin_audience_id: sourceAudienceId,
          lookalike_spec: JSON.stringify({
            type: "similarity",
            country: "BR",
            ratio: percentage / 100,
          }),
          access_token: metaToken,
        }),
      });

      const data = (await res.json()) as any;
      const metaAudienceId = data?.id || null;

      if (!res.ok) {
        console.error(`[AUDIENCE] Erro Meta ao criar LAL ${percentage}%:`, data);
        continue;
      }

      await prisma.lookalikeAudience.create({
        data: {
          name: lalName,
          metaAudienceId,
          sourceAudienceId,
          percentage,
          buyerCountAtCreation: buyerCount,
          status: "created",
        },
      });

      await logAction({
        action: "create_lookalike",
        entityType: "audience",
        entityId: metaAudienceId || "pending",
        entityName: lalName,
        details: `Lookalike ${percentage}% criado com base em ${buyerCount} compradores.`,
        source: "automation",
      });

      await sendNotification("auto_action", {
        action: "NOVO LOOKALIKE CRIADO",
        adset: `LAL ${percentage}% (${buyerCount} compradores)`,
        reason: `Base atingiu ${buyerCount} compradores. Configure um ad set de teste pra validar.`,
      });

      console.log(`[AUDIENCE] LAL ${percentage}% criado: ${metaAudienceId}`);
    } catch (e) {
      console.error(`[AUDIENCE] Erro ao criar LAL ${percentage}%:`, e);
    }
  }
}

export async function getLookalikeStatus() {
  const buyerCount = await prisma.sale.count({ where: { status: "approved" } });
  const nextMilestone = LOOKALIKE_MILESTONES.find((m) => buyerCount < m.buyers);
  const lookalikes = await prisma.lookalikeAudience.findMany({ orderBy: { createdAt: "desc" } });

  return {
    buyer_count: buyerCount,
    next_milestone: nextMilestone?.buyers || null,
    buyers_until_next: nextMilestone ? nextMilestone.buyers - buyerCount : 0,
    lookalikes: lookalikes.map((l) => ({
      id: l.id,
      name: l.name,
      percentage: l.percentage,
      status: l.status,
      meta_audience_id: l.metaAudienceId,
      buyer_count_at_creation: l.buyerCountAtCreation,
      created_at: l.createdAt.toISOString().split("T")[0],
    })),
  };
}
