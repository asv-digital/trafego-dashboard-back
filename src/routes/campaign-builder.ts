import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import prisma from "../prisma";
import { logAction } from "./actions";
import { distributeCreative } from "../services/creative-distributor";
import { sendNotification } from "../services/whatsapp-notifier";
import { canIncreaseBudget, getCurrentAllocation } from "../services/budget-guard";
import { CAMPAIGN_TEMPLATES } from "../config/campaign-templates";

const upload = multer({ dest: "/tmp/uploads/", limits: { fileSize: 500 * 1024 * 1024 } });

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

// ── NOVOS ENDPOINTS (Ponto 1) ──

// POST /upload — Upload de mídia (arquivo direto) → retorna metaId
router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  const { ad_account_id, access_token, page_id } = getMetaConfig();
  if (!access_token || !ad_account_id) {
    res.status(400).json({ error: "Meta API nao configurada" });
    return;
  }

  const file = (req as any).file;
  if (!file) {
    res.status(400).json({ error: "Nenhum arquivo enviado" });
    return;
  }

  const isVideo = file.mimetype?.startsWith("video/");

  try {
    let metaId: string;
    let mediaType: "video" | "image";

    if (isVideo) {
      mediaType = "video";
      // Upload vídeo via form-data
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("source", fs.createReadStream(file.path));
      form.append("access_token", access_token);

      const uploadRes = await fetch(`${META_BASE}/${ad_account_id}/advideos`, {
        method: "POST",
        body: form as any,
        headers: form.getHeaders(),
      });
      const uploadData = (await uploadRes.json()) as any;
      if (uploadData.error) throw new Error(uploadData.error.message);
      metaId = uploadData.id;

      // Polling até status ready (max 5min)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const statusRes = await fetch(`${META_BASE}/${metaId}?fields=status&access_token=${access_token}`);
        const statusData = (await statusRes.json()) as any;
        if (statusData.status?.video_status === "ready") break;
      }
    } else {
      mediaType = "image";
      const imageBuffer = fs.readFileSync(file.path);
      const base64 = imageBuffer.toString("base64");

      const uploadRes = await metaPost(`${ad_account_id}/adimages`, {
        bytes: base64,
      });
      const images = uploadRes.images as Record<string, any> | undefined;
      metaId = images?.bytes?.hash || (images ? Object.values(images)[0]?.hash : "") || "";
    }

    // Cleanup
    try { fs.unlinkSync(file.path); } catch {}

    res.json({ type: mediaType, metaId });
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch {}
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /preview — Cria ad creative e retorna preview URL
router.post("/preview", async (req: Request, res: Response) => {
  const { ad_account_id, access_token, page_id } = getMetaConfig();
  if (!access_token || !ad_account_id || !page_id) {
    res.status(400).json({ error: "Meta API ou META_PAGE_ID nao configurada" });
    return;
  }

  const { mediaType, metaId, primaryText, headline, description, ctaType, linkUrl } = req.body;

  try {
    let objectStorySpec: any;
    if (mediaType === "video") {
      objectStorySpec = {
        page_id,
        video_data: {
          video_id: metaId,
          message: primaryText || "",
          title: headline || "56 Skills de Claude Code",
          description: description || "",
          call_to_action: { type: ctaType || "LEARN_MORE", value: { link: linkUrl || "https://bravy.com.br/skills-claude-code" } },
          link: linkUrl || "https://bravy.com.br/skills-claude-code",
        },
      };
    } else {
      objectStorySpec = {
        page_id,
        link_data: {
          image_hash: metaId,
          message: primaryText || "",
          name: headline || "56 Skills de Claude Code",
          description: description || "",
          link: linkUrl || "https://bravy.com.br/skills-claude-code",
          call_to_action: { type: ctaType || "LEARN_MORE" },
        },
      };
    }

    const creative = await metaPostJSON(`${ad_account_id}/adcreatives`, {
      name: `Preview - ${headline || "Criativo"} - ${new Date().toISOString().slice(0, 10)}`,
      object_story_spec: objectStorySpec,
    });

    // Get preview
    let previewUrl = null;
    try {
      const prevRes = await fetch(`${META_BASE}/${creative.id}/previews?ad_format=DESKTOP_FEED_STANDARD&access_token=${access_token}`);
      const prevData = (await prevRes.json()) as any;
      previewUrl = prevData.data?.[0]?.body || null;
    } catch {}

    res.json({ creativeId: creative.id, previewUrl });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Helper: tenta pausar uma entidade no Meta (para cleanup)
async function tryPauseMeta(entityId: string): Promise<boolean> {
  try {
    await metaPost(entityId, { status: "PAUSED" });
    return true;
  } catch {
    return false;
  }
}

// POST /launch — Cria campanha completa via template (com tracking de steps)
router.post("/launch", async (req: Request, res: Response) => {
  const { ad_account_id, access_token } = getMetaConfig();

  // Log request recebida
  const requestLog: string[] = [];
  const log = (msg: string) => {
    console.log(`[LAUNCH] ${msg}`);
    requestLog.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  };

  // Tracking detalhado
  const steps: Array<{ step: string; status: "pending" | "ok" | "error" | "skipped"; message?: string; metaError?: any }> = [];
  const addStep = (step: string, status: "pending" | "ok" | "error" | "skipped", message?: string, metaError?: any) => {
    const existing = steps.find(s => s.step === step);
    if (existing) {
      existing.status = status;
      if (message) existing.message = message;
      if (metaError) existing.metaError = metaError;
    } else {
      steps.push({ step, status, message, metaError });
    }
  };

  // Resultado parcial (para cleanup em caso de erro)
  const created = { campaignId: null as string | null, adSetIds: [] as string[], adIds: [] as string[] };

  if (!access_token || !ad_account_id) {
    res.status(400).json({ error: "Meta API nao configurada", steps, log: requestLog });
    return;
  }

  const {
    creativeId, campaignType, campaignName, adSetName, adName,
    existingCampaignId, lalAudienceId, customBudget,
    abVariantCreativeId,
  } = req.body;

  log(`Request: type=${campaignType}, creativeId=${creativeId}, budget=${customBudget}`);

  const template = CAMPAIGN_TEMPLATES[campaignType];
  if (!template) {
    res.status(400).json({ error: `Template "${campaignType}" nao encontrado`, steps, log: requestLog });
    return;
  }

  const budgetCentavos = customBudget ? Math.round(customBudget * 100) : template.dailyBudget;
  const budgetReais = budgetCentavos / 100;

  const now = new Date();
  const finalCampaignName = campaignName || `[${template.key}] ${now.toISOString().slice(0, 10)}`;

  // ── STEP 1: Verificação de budget ──
  addStep("budget_check", "pending");
  try {
    const budgetCheck = await canIncreaseBudget(finalCampaignName, budgetReais);
    if (!budgetCheck.allowed) {
      addStep("budget_check", "error", `Budget excederia limite: ${budgetCheck.reason}`);
      log(`Budget check failed: ${budgetCheck.reason}`);
      res.status(400).json({ error: `Budget excederia limite. ${budgetCheck.reason}`, steps, log: requestLog });
      return;
    }
    addStep("budget_check", "ok", `Budget R$${budgetReais}/dia OK. Disponivel: R$${budgetCheck.maxIncrease}`);
    log(`Budget check OK: R$${budgetReais}/dia`);
  } catch (err) {
    addStep("budget_check", "error", `Erro ao verificar budget: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message, steps, log: requestLog });
    return;
  }

  // ── STEP 2: Verificação do creativeId ──
  addStep("creative_validation", "pending");
  if (!creativeId) {
    addStep("creative_validation", "error", "creativeId ausente no request");
    res.status(400).json({ error: "creativeId e obrigatorio", steps, log: requestLog });
    return;
  }
  try {
    // Valida se o creative existe no Meta
    const checkUrl = `${META_BASE}/${creativeId}?fields=id,name&access_token=${access_token}`;
    const checkRes = await fetch(checkUrl);
    const checkData = (await checkRes.json()) as any;
    if (checkData.error) {
      addStep("creative_validation", "error", `Creative nao existe no Meta: ${checkData.error.message}`, checkData.error);
      log(`Creative invalido: ${checkData.error.message}`);
      res.status(400).json({ error: `Creative invalido: ${checkData.error.message}`, steps, log: requestLog });
      return;
    }
    addStep("creative_validation", "ok", `Creative ${checkData.name || creativeId} validado`);
    log(`Creative OK: ${checkData.id}`);
  } catch (err) {
    addStep("creative_validation", "error", `Erro ao validar creative: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message, steps, log: requestLog });
    return;
  }

  let campaignId = existingCampaignId;

  // ── STEP 3: Criar campanha ──
  addStep("create_campaign", "pending");
  try {
    if (!campaignId) {
      const campResult = await metaPost(`${ad_account_id}/campaigns`, {
        name: finalCampaignName,
        objective: template.objective,
        buying_type: template.buyingType,
        special_ad_categories: "[]",
        status: "PAUSED",
      });
      campaignId = campResult.id;
      created.campaignId = campaignId as string;
      addStep("create_campaign", "ok", `Campanha criada: ${campaignId}`);
      log(`Campanha criada: ${campaignId}`);
    } else {
      addStep("create_campaign", "skipped", `Usando campanha existente: ${campaignId}`);
      log(`Usando campanha existente: ${campaignId}`);
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    addStep("create_campaign", "error", errMsg);
    log(`ERRO ao criar campanha: ${errMsg}`);
    res.status(500).json({
      error: `Falha ao criar campanha no Meta. ${errMsg}`,
      hint: errMsg.includes("permission") ? "Token sem permissao ads_management"
          : errMsg.includes("payment") || errMsg.includes("billing") ? "Conta sem metodo de pagamento configurado"
          : errMsg.includes("token") ? "Token expirado ou invalido"
          : "Verifique as permissoes do token e status da conta",
      steps, log: requestLog
    });
    return;
  }

  // ── STEP 4: Preparar targeting ──
  addStep("prepare_targeting", "pending");
  const targeting = { ...template.targeting };
  const targetingWarnings: string[] = [];
  if (campaignType === "PROSPECCAO_LAL") {
    if (!lalAudienceId) {
      targetingWarnings.push("PROSPECCAO_LAL sem lalAudienceId - targeting sera broad");
    } else {
      targeting.custom_audiences = [{ id: lalAudienceId }];
    }
    const buyersId = process.env.META_BUYERS_AUDIENCE_ID || process.env.META_AUDIENCE_BUYERS_ID;
    if (buyersId) targeting.excluded_custom_audiences = [{ id: buyersId }];
    else targetingWarnings.push("META_AUDIENCE_BUYERS_ID nao configurado - compradores nao serao excluidos");
  }
  if (campaignType === "REMARKETING") {
    const abandonersId = process.env.META_AUDIENCE_ABANDONERS_ID;
    if (abandonersId) {
      targeting.custom_audiences = [{ id: abandonersId }];
    } else {
      addStep("prepare_targeting", "error", "META_AUDIENCE_ABANDONERS_ID nao configurado - impossivel criar remarketing");
      res.status(400).json({ error: "Remarketing requer META_AUDIENCE_ABANDONERS_ID configurada", steps, log: requestLog });
      return;
    }
    const buyersId = process.env.META_BUYERS_AUDIENCE_ID || process.env.META_AUDIENCE_BUYERS_ID;
    if (buyersId) targeting.excluded_custom_audiences = [{ id: buyersId }];
    else targetingWarnings.push("Compradores nao serao excluidos do remarketing");
  }
  addStep("prepare_targeting", "ok", targetingWarnings.length > 0 ? `Avisos: ${targetingWarnings.join("; ")}` : "Targeting OK");
  log(`Targeting preparado${targetingWarnings.length ? " com avisos" : ""}`);

  // ── STEP 5: Criar ad set(s) ──
  const adsetCount = campaignType === "TESTE_AB" ? 2 : 1;
  const creativeIds = campaignType === "TESTE_AB" && abVariantCreativeId
    ? [creativeId, abVariantCreativeId]
    : [creativeId];

  for (let i = 0; i < adsetCount; i++) {
    const stepKey = `create_adset_${i + 1}`;
    addStep(stepKey, "pending");
    const setName = adsetCount > 1
      ? `${adSetName || "Ad Set"} - Variante ${String.fromCharCode(65 + i)}`
      : adSetName || "Ad Set";

    try {
      const adsetResult = await metaPost(`${ad_account_id}/adsets`, {
        campaign_id: campaignId!,
        name: setName,
        daily_budget: String(budgetCentavos),
        billing_event: template.billingEvent,
        optimization_goal: template.optimizationGoal,
        promoted_object: JSON.stringify({ pixel_id: process.env.META_PIXEL_ID || "", custom_event_type: "PURCHASE" }),
        targeting: JSON.stringify(targeting),
        status: "PAUSED",
        start_time: new Date().toISOString(),
      });
      created.adSetIds.push(adsetResult.id);
      addStep(stepKey, "ok", `Ad set criado: ${adsetResult.id} (${setName})`);
      log(`Ad set ${i + 1} criado: ${adsetResult.id}`);
    } catch (err) {
      const errMsg = (err as Error).message;
      addStep(stepKey, "error", errMsg);
      log(`ERRO ao criar ad set ${i + 1}: ${errMsg}`);

      // Cleanup: pausar a campanha que foi criada
      if (created.campaignId) {
        log(`Cleanup: pausando campanha ${created.campaignId}`);
        await tryPauseMeta(created.campaignId);
      }

      res.status(500).json({
        error: `Falha ao criar ad set. ${errMsg}`,
        hint: errMsg.includes("pixel") ? "Pixel ID invalido ou sem permissao"
            : errMsg.includes("target") ? "Targeting invalido - verifique audiences e params"
            : errMsg.includes("budget") ? "Budget invalido ou fora do range permitido"
            : "Verifique targeting, pixel_id e permissoes",
        partial_results: created,
        cleanup: "Campanha criada foi pausada",
        steps, log: requestLog
      });
      return;
    }

    // ── STEP 6: Criar ad ──
    const adStepKey = `create_ad_${i + 1}`;
    addStep(adStepKey, "pending");
    const adCreativeId = creativeIds[i] || creativeIds[0];
    const finalAdName = adsetCount > 1
      ? `${adName || "Ad"} - Variante ${String.fromCharCode(65 + i)}`
      : adName || "Ad";

    try {
      const adResult = await metaPost(`${ad_account_id}/ads`, {
        adset_id: created.adSetIds[i],
        name: finalAdName,
        creative: JSON.stringify({ creative_id: adCreativeId }),
        status: "PAUSED",
      });
      created.adIds.push(adResult.id);
      addStep(adStepKey, "ok", `Ad criado: ${adResult.id}`);
      log(`Ad ${i + 1} criado: ${adResult.id}`);
    } catch (err) {
      const errMsg = (err as Error).message;
      addStep(adStepKey, "error", errMsg);
      log(`ERRO ao criar ad ${i + 1}: ${errMsg}`);

      // Cleanup
      if (created.campaignId) await tryPauseMeta(created.campaignId);

      res.status(500).json({
        error: `Falha ao criar ad. ${errMsg}`,
        hint: errMsg.includes("creative") ? "Creative ID invalido ou incompativel com o ad set"
            : "Verifique creative_id",
        partial_results: created,
        cleanup: "Campanha pausada",
        steps, log: requestLog
      });
      return;
    }
  }

  // ── STEP 7: Ativar tudo ──
  addStep("activate", "pending");
  const activationErrors: string[] = [];
  try {
    await metaPost(campaignId!, { status: "ACTIVE" });
    log(`Campanha ${campaignId} ativada`);
    for (const asId of created.adSetIds) {
      try {
        await metaPost(asId, { status: "ACTIVE" });
        log(`Ad set ${asId} ativado`);
      } catch (err) {
        activationErrors.push(`Ad set ${asId}: ${(err as Error).message}`);
      }
    }
    for (const adId of created.adIds) {
      try {
        await metaPost(adId, { status: "ACTIVE" });
        log(`Ad ${adId} ativado`);
      } catch (err) {
        activationErrors.push(`Ad ${adId}: ${(err as Error).message}`);
      }
    }

    if (activationErrors.length > 0) {
      addStep("activate", "error", `Parcial: ${activationErrors.join("; ")}`);
    } else {
      addStep("activate", "ok", "Todas entidades ativas");
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    addStep("activate", "error", errMsg);
    log(`ERRO na ativacao: ${errMsg}`);
    // Não faz cleanup aqui — a campanha foi criada, deixa como está
    res.status(500).json({
      error: `Campanha criada mas falhou ao ativar. ${errMsg}`,
      hint: "Entidades foram criadas pausadas no Meta. Ative manualmente no Ads Manager.",
      partial_results: created,
      steps, log: requestLog
    });
    return;
  }

  // ── STEP 8: Registrar no banco ──
  addStep("save_db", "pending");
  try {
    const learningPhaseEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    await prisma.campaign.create({
      data: {
        name: finalCampaignName,
        type: template.label,
        dailyBudget: budgetReais * adsetCount,
        startDate: now,
        status: "Ativa",
        createdInMetaAt: now,
        learningPhaseEnd,
        isInLearningPhase: true,
      },
    });

    if (campaignType === "TESTE_AB" && abVariantCreativeId) {
      await prisma.creativeTest.create({
        data: {
          name: `AB - ${finalCampaignName}`,
          status: "running",
          adsetId: created.adSetIds[0],
          variantA: { adId: created.adIds[0], name: "Variante A" },
          variantB: { adId: created.adIds[1], name: "Variante B" },
          startDate: now,
        },
      });
    }
    addStep("save_db", "ok", "Campanha salva no banco");
  } catch (err) {
    addStep("save_db", "error", `Erro ao salvar no banco: ${(err as Error).message} (campanha ativa no Meta)`);
    log(`ERRO ao salvar no banco: ${(err as Error).message}`);
    // Não falha totalmente — a campanha está no Meta, só não foi salva no banco
  }

  // ── STEP 9: Log + Notificação ──
  addStep("notify", "pending");
  try {
    await logAction({
      action: "campaign_launched",
      entityType: "campaign",
      entityId: campaignId!,
      entityName: finalCampaignName,
      details: `Tipo: ${template.label} | Budget: R$${budgetReais}/dia | ${created.adSetIds.length} ad set(s) | ${created.adIds.length} ad(s)`,
      source: "dashboard",
    });

    await sendNotification("auto_action", {
      action: "CAMPANHA CRIADA",
      adset: finalCampaignName,
      reason: `Tipo: ${template.label} | Budget: R$${budgetReais * adsetCount}/dia | Lancada e ativa.`,
    });
    addStep("notify", "ok");
  } catch (err) {
    addStep("notify", "error", (err as Error).message);
  }

  log(`Launch completo: campanha=${campaignId}, adsets=${created.adSetIds.length}, ads=${created.adIds.length}`);

  res.json({
    campaignId: created.campaignId,
    adSetIds: created.adSetIds,
    adIds: created.adIds,
    status: "active",
    message: `Campanha lancada: ${finalCampaignName}`,
    steps,
    log: requestLog,
  });
});

// GET /audiences — Lista audiências disponíveis
router.get("/audiences", async (_req: Request, res: Response) => {
  const { ad_account_id, access_token } = getMetaConfig();
  if (!access_token || !ad_account_id) {
    res.json({ audiences: [] });
    return;
  }

  try {
    const url = new URL(`${META_BASE}/${ad_account_id}/customaudiences`);
    url.searchParams.set("access_token", access_token);
    url.searchParams.set("fields", "name,approximate_count,subtype");
    url.searchParams.set("limit", "100");
    const metaRes = await fetch(url.toString());
    const metaData = (await metaRes.json()) as any;

    const dbLookalikes = await prisma.lookalikeAudience.findMany();

    res.json({
      meta_audiences: (metaData.data || []).map((a: any) => ({
        id: a.id, name: a.name, count: a.approximate_count, subtype: a.subtype,
      })),
      lookalikes: dbLookalikes,
    });
  } catch (err) {
    res.json({ meta_audiences: [], lookalikes: [] });
  }
});

// GET /campaigns — Lista campanhas ativas para dropdown
router.get("/campaigns", async (_req: Request, res: Response) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { status: "Ativa" },
      select: { id: true, name: true, type: true, dailyBudget: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ campaigns });
  } catch {
    res.json({ campaigns: [] });
  }
});

// GET /launch-templates — Retorna templates novos (Ponto 1)
router.get("/launch-templates", (_req: Request, res: Response) => {
  const templates = Object.values(CAMPAIGN_TEMPLATES).map(t => ({
    key: t.key, label: t.label, description: t.description, suggestedBudget: t.suggestedBudgetReais,
  }));
  res.json({ templates });
});

export default router;
