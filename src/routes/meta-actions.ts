import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { logAction } from "./actions";

const router = Router();

const META_BASE = "https://graph.facebook.com/v19.0";

function getMetaConfig() {
  if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
    return {
      access_token: process.env.META_ACCESS_TOKEN,
      ad_account_id: process.env.META_AD_ACCOUNT_ID,
    };
  }
  try {
    const configPath = path.resolve(__dirname, "../../agent-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.meta;
  } catch {
    return { access_token: "", ad_account_id: "" };
  }
}

// NÃO destrutura no module load — env vars podem ainda não ter sido carregadas
// pelo dotenv nesse momento (timing de import vs config). Cada chamada resolve
// via getMetaConfig() pra sempre pegar o valor mais atual do process.env.

// ---------------------------------------------------------------------------
// Naming Convention Helpers
// ---------------------------------------------------------------------------

function buildCampaignName(params: { type?: string; product?: string; objective?: string }): string {
  const date = new Date().toISOString().slice(0, 7);
  const typeMap: Record<string, string> = {
    remarketing: "RMK",
    prospeccao: "PROSP",
    escala: "ESCALA",
    lookalike: "LAL",
    advantage_plus: "ASC",
  };
  const prefix = typeMap[params.type?.toLowerCase() ?? ""] || (params.type?.toUpperCase() ?? "CAMP");
  const product = params.product || "56 Skills";
  const objective = params.objective || "Purchase";
  return `${prefix} | ${product} | ${objective} | ${date}`;
}

function buildAdsetName(params: { audience?: string; segmentation?: string }): string {
  return `${params.audience || "Broad"} | ${params.segmentation || "Default"}`;
}

function buildAdName(params: { format?: string; hook?: string; version?: number }): string {
  const formatMap: Record<string, string> = {
    talking_head: "TH",
    screen_recording: "SR",
    carousel: "CARR",
    image: "IMG",
    ugc: "UGC",
    reels: "RL",
  };
  const prefix = formatMap[params.format?.toLowerCase() ?? ""] || (params.format?.toUpperCase() ?? "AD");
  return `${prefix} | ${params.hook || "Default"} | v${params.version || 1}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MetaError {
  error?: { message: string; type: string; code: number };
}

async function metaPost(endpoint: string, params: Record<string, string>) {
  const { access_token } = getMetaConfig();
  if (!access_token) throw { status: 500, message: "META_ACCESS_TOKEN não configurado" };
  const url = new URL(`${META_BASE}/${endpoint}`);
  url.searchParams.set("access_token", access_token);

  const body = new URLSearchParams(params);

  const response = await fetch(url.toString(), {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const data = (await response.json()) as MetaError & Record<string, unknown>;

  if (data.error) {
    throw { status: response.status, message: data.error.message };
  }

  return data;
}

async function metaGet(endpoint: string, params: Record<string, string> = {}) {
  const { access_token } = getMetaConfig();
  if (!access_token) throw { status: 500, message: "META_ACCESS_TOKEN não configurado" };
  const url = new URL(`${META_BASE}/${endpoint}`);
  url.searchParams.set("access_token", access_token);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());
  const data = (await response.json()) as MetaError & Record<string, unknown>;

  if (data.error) {
    throw { status: response.status, message: data.error.message };
  }

  return data;
}

// ---------------------------------------------------------------------------
// 1. POST /campaigns/create — Create a new campaign
// ---------------------------------------------------------------------------
router.post("/campaigns/create", async (req: Request, res: Response) => {
  try {
    const { name, objective, daily_budget, status, auto_name, campaign_type, product } = req.body;

    const finalName = (auto_name || !name)
      ? buildCampaignName({ type: campaign_type, product, objective })
      : name;

    console.log(`[meta-actions] Creating campaign: ${finalName}`);

    // Meta Graph API exige budget em CENTAVOS (ex: R$150 = 15000).
    // Frontend envia em reais — converte aqui.
    const budgetCents = Math.round(Number(daily_budget) * 100);
    const data = await metaPost(`${getMetaConfig().ad_account_id}/campaigns`, {
      name: finalName,
      objective,
      status: status || "PAUSED",
      special_ad_categories: "[]",
      daily_budget: String(budgetCents),
    });

    const campaignId = (data as Record<string, unknown>).id as string;
    console.log(`[meta-actions] Campaign created: ${campaignId}`);

    await logAction({
      action: "create",
      entityType: "campaign",
      entityId: campaignId,
      entityName: finalName,
      details: `Campaign created with objective ${objective}, budget ${daily_budget}`,
    });

    res.status(201).json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error creating campaign:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 2. POST /adsets/create — Create a new ad set
// ---------------------------------------------------------------------------
router.post("/adsets/create", async (req: Request, res: Response) => {
  try {
    const {
      campaign_id,
      name,
      daily_budget,
      targeting,
      billing_event,
      optimization_goal,
      start_time,
      auto_name,
      audience,
      segmentation,
    } = req.body;

    const finalName = (auto_name || !name)
      ? buildAdsetName({ audience, segmentation })
      : name;

    console.log(`[meta-actions] Creating ad set: ${finalName}`);

    const params: Record<string, string> = {
      campaign_id,
      name: finalName,
      daily_budget: String(daily_budget),
      billing_event: billing_event || "IMPRESSIONS",
      optimization_goal,
      start_time,
      targeting: typeof targeting === "string" ? targeting : JSON.stringify(targeting),
    };

    const data = await metaPost(`${getMetaConfig().ad_account_id}/adsets`, params);

    console.log(`[meta-actions] Ad set created: ${(data as Record<string, unknown>).id}`);
    res.status(201).json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error creating ad set:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 3. PATCH /campaigns/:id/status — Update campaign status
// ---------------------------------------------------------------------------
router.patch("/campaigns/:id/status", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status } = req.body;

    console.log(`[meta-actions] Updating campaign ${id} status to ${status}`);

    const data = await metaPost(id, { status });

    await logAction({
      action: status === "PAUSED" ? "pause" : "activate",
      entityType: "campaign",
      entityId: id,
      entityName: id,
      details: `Status changed to ${status}`,
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error updating campaign status:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 3b. PATCH /campaigns/:id/budget — Update campaign daily budget
// ---------------------------------------------------------------------------
router.patch("/campaigns/:id/budget", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { daily_budget } = req.body;

    // Frontend envia em reais — Meta API exige centavos.
    const budgetInCents = String(Math.round(Number(daily_budget) * 100));

    console.log(`[meta-actions] Updating campaign ${id} budget to ${budgetInCents} (cents) = R$${daily_budget}`);

    const data = await metaPost(id, { daily_budget: budgetInCents });

    await logAction({
      action: "budget_update",
      entityType: "campaign",
      entityId: id,
      entityName: id,
      details: `Daily budget changed to R$${daily_budget} (${budgetInCents} cents)`,
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error updating campaign budget:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 4. PATCH /adsets/:id/status — Update ad set status
// ---------------------------------------------------------------------------
router.patch("/adsets/:id/status", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status } = req.body;

    console.log(`[meta-actions] Updating ad set ${id} status to ${status}`);

    const data = await metaPost(id, { status });

    await logAction({
      action: status === "PAUSED" ? "pause" : "activate",
      entityType: "adset",
      entityId: id,
      entityName: id,
      details: `Status changed to ${status}`,
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error updating ad set status:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 5. PATCH /adsets/:id/budget — Update ad set daily budget
// ---------------------------------------------------------------------------
router.patch("/adsets/:id/budget", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { daily_budget } = req.body;

    // Meta API expects budget in cents — multiply by 100
    const budgetInCents = String(Number(daily_budget) * 100);

    console.log(`[meta-actions] Updating ad set ${id} budget to ${budgetInCents} (cents)`);

    const data = await metaPost(id, { daily_budget: budgetInCents });

    await logAction({
      action: "budget_update",
      entityType: "adset",
      entityId: id,
      entityName: id,
      details: `Budget updated to R$${daily_budget} (${budgetInCents} cents)`,
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error updating ad set budget:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 6. GET /campaigns/live — Fetch all campaigns with live metrics
// ---------------------------------------------------------------------------
router.get("/campaigns/live", async (_req: Request, res: Response) => {
  try {
    console.log("[meta-actions] Fetching live campaigns");

    const data = await metaGet(`${getMetaConfig().ad_account_id}/campaigns`, {
      fields:
        "id,name,status,daily_budget,lifetime_budget,objective,created_time",
    });

    res.json((data as any).data ?? []);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching live campaigns:", error.message);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// 7. GET /adsets/live — Fetch all ad sets with live status
// ---------------------------------------------------------------------------
router.get("/adsets/live", async (_req: Request, res: Response) => {
  try {
    console.log("[meta-actions] Fetching live ad sets");

    const data = await metaGet(`${getMetaConfig().ad_account_id}/adsets`, {
      fields:
        "id,name,campaign_id,status,daily_budget,targeting,optimization_goal",
    });

    res.json((data as any).data ?? []);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching live ad sets:", error.message);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// 8. GET /insights/realtime — Today's insights for all campaigns
// ---------------------------------------------------------------------------
router.get("/insights/realtime", async (_req: Request, res: Response) => {
  try {
    console.log("[meta-actions] Fetching realtime insights");

    const data = await metaGet(`${getMetaConfig().ad_account_id}/insights`, {
      fields:
        "campaign_name,campaign_id,spend,impressions,clicks,actions,cpm,cpc,ctr,frequency",
      date_preset: "today",
      level: "campaign",
    });

    res.json((data as any).data ?? []);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching realtime insights:", error.message);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// 9. GET /insights/range — Insights for a date range
// ---------------------------------------------------------------------------
router.get("/insights/range", async (req: Request, res: Response) => {
  try {
    const since = req.query.since as string;
    const until = req.query.until as string;
    const level = (req.query.level as string) || "campaign";

    console.log(`[meta-actions] Fetching insights range: ${since} to ${until} (${level})`);

    const data = await metaGet(`${getMetaConfig().ad_account_id}/insights`, {
      fields:
        "campaign_name,campaign_id,spend,impressions,clicks,actions,cpm,cpc,ctr,frequency",
      time_range: JSON.stringify({ since, until }),
      level,
      time_increment: "1",
    });

    res.json((data as any).data ?? []);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching insights range:", error.message);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// 10. GET /insights/pacing — Budget pacing for today (Melhoria 11)
// ---------------------------------------------------------------------------
router.get("/insights/pacing", async (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  const dailyBudget = Number(process.env.META_DAILY_BUDGET) || 500;

  try {
    console.log("[meta-actions] Fetching pacing insights");

    const data = await metaGet(`${getMetaConfig().ad_account_id}/insights`, {
      fields: "spend",
      date_preset: "today",
      level: "account",
    });

    const rows = (data as any).data ?? [];
    const spentToday = rows.length > 0 ? parseFloat(rows[0].spend || "0") : 0;

    const now = new Date();
    const percentDayElapsed = parseFloat(
      ((now.getHours() + now.getMinutes() / 60) / 24 * 100).toFixed(2)
    );
    const percentBudgetSpent = dailyBudget > 0
      ? parseFloat(((spentToday / dailyBudget) * 100).toFixed(2))
      : 0;

    let pacingStatus: string;
    if (percentBudgetSpent < percentDayElapsed - 20) {
      pacingStatus = "underpacing";
    } else if (percentBudgetSpent > percentDayElapsed + 20) {
      pacingStatus = "overpacing";
    } else {
      pacingStatus = "on_track";
    }

    const projectedSpend = percentDayElapsed > 0
      ? parseFloat(((spentToday / percentDayElapsed) * 100).toFixed(2))
      : 0;

    const messages: Record<string, string> = {
      underpacing: `Gastando abaixo do esperado. ${percentBudgetSpent.toFixed(1)}% do budget com ${percentDayElapsed.toFixed(1)}% do dia.`,
      overpacing: `Gastando acima do esperado. ${percentBudgetSpent.toFixed(1)}% do budget com ${percentDayElapsed.toFixed(1)}% do dia.`,
      on_track: `Pacing saudável. ${percentBudgetSpent.toFixed(1)}% do budget com ${percentDayElapsed.toFixed(1)}% do dia.`,
    };

    res.json({
      date: today,
      daily_budget: dailyBudget,
      spent_today: spentToday,
      percent_budget_spent: percentBudgetSpent,
      percent_day_elapsed: percentDayElapsed,
      pacing_status: pacingStatus,
      projected_spend: projectedSpend,
      message: messages[pacingStatus],
    });
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching pacing:", error.message);
    res.json({
      date: today,
      daily_budget: dailyBudget,
      spent_today: 0,
      percent_budget_spent: 0,
      percent_day_elapsed: parseFloat(
        ((new Date().getHours() + new Date().getMinutes() / 60) / 24 * 100).toFixed(2)
      ),
      pacing_status: "unknown",
      projected_spend: 0,
      message: "Erro ao buscar dados do Meta. Retornando zeros.",
    });
  }
});

export default router;
