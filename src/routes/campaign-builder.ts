import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import prisma from "../prisma";
import { logAction } from "./actions";
import { distributeCreative } from "../services/creative-distributor";

const router = Router();

const META_BASE = "https://graph.facebook.com/v19.0";

function getMetaConfig() {
  if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
    return {
      access_token: process.env.META_ACCESS_TOKEN,
      ad_account_id: process.env.META_AD_ACCOUNT_ID,
      page_id: process.env.META_PAGE_ID || "",
      instagram_actor_id: process.env.META_INSTAGRAM_ACTOR_ID || "",
    };
  }
  try {
    const configPath = path.resolve(__dirname, "../../agent-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return { ...config.meta, page_id: "", instagram_actor_id: "" };
  } catch {
    return { access_token: "", ad_account_id: "", page_id: "", instagram_actor_id: "" };
  }
}

// ── Meta API helpers ──

async function metaPost(endpoint: string, params: Record<string, string>) {
  const { access_token } = getMetaConfig();
  const url = new URL(`${META_BASE}/${endpoint}`);
  url.searchParams.set("access_token", access_token);
  const body = new URLSearchParams(params);
  const res = await fetch(url.toString(), {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const data = (await res.json()) as any;
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function metaPostJSON(endpoint: string, body: any) {
  const { access_token } = getMetaConfig();
  const url = `${META_BASE}/${endpoint}?access_token=${access_token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (data.error) throw new Error(data.error.message);
  return data;
}

// ── Campaign Templates ──

interface CampaignTemplate {
  id: string;
  name: string;
  description: string;
  type: string;
  totalBudget: number;
  adsets: AdsetTemplate[];
}

interface AdsetTemplate {
  name: string;
  budget: number;
  audienceDescription: string;
  targeting: any;
  exclusions?: string[];
}

const TEMPLATES: CampaignTemplate[] = [
  {
    id: "remarketing_quente",
    name: "Remarketing — Público Quente",
    description: "Engajou IG, visitantes LP, vídeo viewers. Exclui compradores 180d. R$150/dia.",
    type: "Remarketing",
    totalBudget: 15000,
    adsets: [
      {
        name: "Engajou IG JP 30d",
        budget: 5000,
        audienceDescription: "Engajou Instagram @jp.asv nos últimos 30 dias. Exclui compradores 180d.",
        targeting: { geo_locations: { countries: ["BR"] }, age_min: 25, age_max: 40, publisher_platforms: ["facebook", "instagram"] },
      },
      {
        name: "Engajou IG JP + Bravy 90d",
        budget: 5000,
        audienceDescription: "Engajou @jp.asv ou @asv.digital nos últimos 90 dias. Exclui compradores 180d.",
        targeting: { geo_locations: { countries: ["BR"] }, age_min: 25, age_max: 40, publisher_platforms: ["facebook", "instagram"] },
      },
      {
        name: "Visitantes LP + Video Viewers",
        budget: 5000,
        audienceDescription: "Visitou bravy.com.br/skills ou assistiu 75% de um vídeo. Exclui compradores 180d.",
        targeting: { geo_locations: { countries: ["BR"] }, age_min: 25, age_max: 40, publisher_platforms: ["facebook", "instagram"] },
      },
    ],
  },
  {
    id: "prospeccao_frio",
    name: "Prospecção — Frio + LAL + Broad",
    description: "Lookalikes, interesses e Broad targeting. Exclui públicos quentes + compradores 180d. R$200/dia.",
    type: "Prospecção",
    totalBudget: 20000,
    adsets: [
      {
        name: "LAL 1% Engajados JP",
        budget: 5000,
        audienceDescription: "Lookalike 1% dos que engajaram com @jp.asv. Exclui públicos quentes + compradores 180d.",
        targeting: { geo_locations: { countries: ["BR"] }, age_min: 25, age_max: 40, publisher_platforms: ["facebook", "instagram"] },
      },
      {
        name: "Empreendedores Tech",
        budget: 5000,
        audienceDescription: "Interesses: Empreendedorismo + IA + Startups. 25-40 anos. Exclui públicos quentes + compradores 180d.",
        targeting: {
          geo_locations: { countries: ["BR"] }, age_min: 25, age_max: 40, publisher_platforms: ["facebook", "instagram"],
          flexible_spec: [{ interests: [{ id: "6003107902433", name: "Entrepreneurship" }, { id: "6003966451572", name: "Artificial intelligence" }] }],
        },
      },
      {
        name: "Donos de Negócio",
        budget: 5000,
        audienceDescription: "Interesses: Gestão empresarial + PME. 28-40 anos. Exclui públicos quentes + compradores 180d.",
        targeting: {
          geo_locations: { countries: ["BR"] }, age_min: 28, age_max: 40, publisher_platforms: ["facebook", "instagram"],
          flexible_spec: [{ interests: [{ id: "6003384235398", name: "Business management" }, { id: "6003348604030", name: "Small and medium-sized enterprises" }] }],
        },
      },
      {
        name: "BROAD — Algoritmo Decide",
        budget: 5000,
        audienceDescription: "Sem interesses. Brasil 25-40, ambos gêneros. Pixel + CAPI guiam o algoritmo. Exclui compradores 180d.",
        targeting: { geo_locations: { countries: ["BR"] }, age_min: 25, age_max: 40, publisher_platforms: ["facebook", "instagram"] },
      },
    ],
  },
  {
    id: "asc_shopping",
    name: "Advantage+ Shopping Campaign (ASC)",
    description: "Campanha totalmente automatizada do Meta. Sem ad sets manuais. 3-5 criativos, Meta otimiza sozinho. R$100/dia.",
    type: "ASC",
    totalBudget: 10000,
    adsets: [
      {
        name: "ASC — Auto Otimizado",
        budget: 10000,
        audienceDescription: "Meta gerencia audiência automaticamente via algoritmo. Sem segmentação manual.",
        targeting: { geo_locations: { countries: ["BR"] } },
      },
    ],
  },
];

// ── Routes ──

// GET /templates — lista templates disponíveis
router.get("/templates", (_req: Request, res: Response) => {
  const safe = TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    type: t.type,
    totalBudget: t.totalBudget / 100,
    adsetCount: t.adsets.length,
    adsets: t.adsets.map((a) => ({
      name: a.name,
      budget: a.budget / 100,
      audienceDescription: a.audienceDescription,
    })),
  }));
  res.json(safe);
});

// POST /upload-creative — Upload de imagem/vídeo como Ad Creative no Meta
router.post("/upload-creative", async (req: Request, res: Response) => {
  const { ad_account_id, access_token, page_id } = getMetaConfig();

  if (!access_token || !ad_account_id) {
    res.status(400).json({ error: "Meta API not configured" });
    return;
  }

  const {
    name,
    media_url, // URL pública da imagem ou vídeo
    media_type, // "image" ou "video"
    body_text, // Copy do anúncio
    title, // Headline
    link_url, // URL de destino (LP)
    call_to_action, // LEARN_MORE, SHOP_NOW, etc
  } = req.body;

  try {
    let creativeData: any;

    if (media_type === "video") {
      // 1. Upload video via URL
      console.log(`[campaign-builder] Uploading video: ${name}`);
      const videoResult = await metaPost(`${ad_account_id}/advideos`, {
        file_url: media_url,
        title: name,
      });
      const videoId = videoResult.id;
      console.log(`[campaign-builder] Video uploaded: ${videoId}`);

      // 2. Create Ad Creative with video
      creativeData = await metaPostJSON(`${ad_account_id}/adcreatives`, {
        name: name,
        object_story_spec: {
          page_id: page_id,
          video_data: {
            video_id: videoId,
            message: body_text || "",
            title: title || "56 Skills de Claude Code",
            call_to_action: {
              type: call_to_action || "LEARN_MORE",
              value: { link: link_url || "https://bravy.com.br/skills-claude-code" },
            },
          },
        },
      });
    } else {
      // Image creative
      console.log(`[campaign-builder] Creating image creative: ${name}`);
      creativeData = await metaPostJSON(`${ad_account_id}/adcreatives`, {
        name: name,
        object_story_spec: {
          page_id: page_id,
          link_data: {
            image_url: media_url,
            message: body_text || "",
            name: title || "56 Skills de Claude Code",
            link: link_url || "https://bravy.com.br/skills-claude-code",
            call_to_action: {
              type: call_to_action || "LEARN_MORE",
            },
          },
        },
      });
    }

    const creativeId = creativeData.id;
    console.log(`[campaign-builder] Creative created: ${creativeId}`);

    // Save to database
    await prisma.creative.create({
      data: {
        name,
        type: media_type === "video" ? "Vídeo" : "Imagem",
        status: "Ativo",
        campaignId: (await prisma.campaign.findFirst({ orderBy: { createdAt: "desc" } }))?.id ?? "",
      },
    });

    await logAction({
      action: "upload_creative",
      entityType: "creative",
      entityId: creativeId,
      entityName: name,
      details: `Tipo: ${media_type}`,
    });

    res.status(201).json({
      success: true,
      creative_id: creativeId,
      message: `Criativo "${name}" criado com sucesso no Meta.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[campaign-builder] Upload error:", message);
    res.status(500).json({ error: message });
  }
});

// POST /build — Cria campanha completa a partir de um template + criativos
router.post("/build", async (req: Request, res: Response) => {
  const { ad_account_id, access_token } = getMetaConfig();

  if (!access_token || !ad_account_id) {
    res.status(400).json({ error: "Meta API not configured" });
    return;
  }

  const {
    template_id, // ID do template
    creative_ids, // Array de Meta creative IDs
    custom_name, // Nome customizado (opcional)
    start_paused, // Se true, cria PAUSED (default true)
  } = req.body;

  const template = TEMPLATES.find((t) => t.id === template_id);
  if (!template) {
    res.status(400).json({ error: `Template "${template_id}" not found` });
    return;
  }

  if (!creative_ids || !Array.isArray(creative_ids) || creative_ids.length === 0) {
    res.status(400).json({ error: "At least one creative_id is required" });
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const typePrefix = template.type === "Remarketing" ? "RMK" : template.type === "Prospecção" ? "PROSP" : "ESCALA";
  const campaignName = custom_name || `${typePrefix} | 56 Skills | Purchase | ${date}`;
  const status = start_paused !== false ? "PAUSED" : "ACTIVE";

  const results: any = { campaign: null, adsets: [], ads: [], errors: [] };

  try {
    // 1. Create Campaign
    console.log(`[campaign-builder] Creating campaign: ${campaignName}`);
    const campaignResult = await metaPost(`${ad_account_id}/campaigns`, {
      name: campaignName,
      objective: "OUTCOME_SALES",
      status,
      special_ad_categories: "[]",
    });
    results.campaign = { id: campaignResult.id, name: campaignName };
    console.log(`[campaign-builder] Campaign created: ${campaignResult.id}`);

    // Save to DB with learning phase (Passo 9)
    const now = new Date();
    const learningPhaseEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const dbCampaign = await prisma.campaign.create({
      data: {
        name: campaignName,
        type: template.type,
        audience: template.description,
        dailyBudget: template.totalBudget / 100,
        startDate: now,
        status: status === "PAUSED" ? "Pausada" : "Ativa",
        createdInMetaAt: now,
        learningPhaseEnd,
        isInLearningPhase: true,
      },
    });

    // 2. Create Ad Sets
    for (const adsetTemplate of template.adsets) {
      const adsetName = `${adsetTemplate.name} | ${typePrefix}`;
      try {
        console.log(`[campaign-builder] Creating adset: ${adsetName}`);
        const adsetResult = await metaPost(`${ad_account_id}/adsets`, {
          campaign_id: campaignResult.id,
          name: adsetName,
          daily_budget: String(adsetTemplate.budget),
          billing_event: "IMPRESSIONS",
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: JSON.stringify({ pixel_id: process.env.META_PIXEL_ID || "", custom_event_type: "PURCHASE" }),
          targeting: JSON.stringify(adsetTemplate.targeting),
          status,
          start_time: new Date().toISOString(),
        });
        results.adsets.push({ id: adsetResult.id, name: adsetName });
        console.log(`[campaign-builder] Adset created: ${adsetResult.id}`);

        // 3. Create Ads (one per creative in this adset)
        for (let i = 0; i < creative_ids.length; i++) {
          const adName = `Ad ${i + 1} | ${adsetName}`;
          try {
            console.log(`[campaign-builder] Creating ad: ${adName}`);
            const adResult = await metaPost(`${ad_account_id}/ads`, {
              adset_id: adsetResult.id,
              name: adName,
              creative: JSON.stringify({ creative_id: creative_ids[i] }),
              status,
            });
            results.ads.push({ id: adResult.id, name: adName, adset: adsetName });
            console.log(`[campaign-builder] Ad created: ${adResult.id}`);
          } catch (adErr) {
            const msg = adErr instanceof Error ? adErr.message : String(adErr);
            results.errors.push({ step: "ad", adset: adsetName, creative: creative_ids[i], error: msg });
            console.error(`[campaign-builder] Ad error: ${msg}`);
          }
        }
      } catch (adsetErr) {
        const msg = adsetErr instanceof Error ? adsetErr.message : String(adsetErr);
        results.errors.push({ step: "adset", name: adsetName, error: msg });
        console.error(`[campaign-builder] Adset error: ${msg}`);
      }
    }

    await logAction({
      action: "build_campaign",
      entityType: "campaign",
      entityId: campaignResult.id,
      entityName: campaignName,
      details: `Template: ${template.name} | ${results.adsets.length} conjuntos | ${results.ads.length} anúncios | ${results.errors.length} erros`,
    });

    res.status(201).json({
      success: true,
      message: `Campanha "${campaignName}" criada com ${results.adsets.length} conjuntos e ${results.ads.length} anúncios.${status === "PAUSED" ? " Status: PAUSADA — ative quando estiver pronto." : ""}`,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[campaign-builder] Build error:", message);
    res.status(500).json({ error: message, partial_results: results });
  }
});

// POST /distribute — Distribute creative to all active adsets + ASC
router.post("/distribute", async (req: Request, res: Response) => {
  const { creative_id, creative_name } = req.body;

  if (!creative_id) {
    res.status(400).json({ error: "creative_id is required" });
    return;
  }

  try {
    const result = await distributeCreative(creative_id, creative_name || "Novo Criativo");
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[campaign-builder] Distribute error:", message);
    res.status(500).json({ error: message });
  }
});

export default router;
