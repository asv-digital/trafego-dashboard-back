import { Router, Request, Response } from "express";
import config from "../../agent-config.json";

const router = Router();

const META_BASE = "https://graph.facebook.com/v19.0";
const { access_token, ad_account_id } = config.meta;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MetaError {
  error?: { message: string; type: string; code: number };
}

async function metaPost(endpoint: string, params: Record<string, string>) {
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
    const { name, objective, daily_budget, status } = req.body;

    console.log(`[meta-actions] Creating campaign: ${name}`);

    const data = await metaPost(`${ad_account_id}/campaigns`, {
      name,
      objective,
      status: status || "PAUSED",
      special_ad_categories: "[]",
      daily_budget: String(daily_budget),
    });

    console.log(`[meta-actions] Campaign created: ${(data as Record<string, unknown>).id}`);
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
    } = req.body;

    console.log(`[meta-actions] Creating ad set: ${name}`);

    const params: Record<string, string> = {
      campaign_id,
      name,
      daily_budget: String(daily_budget),
      billing_event: billing_event || "IMPRESSIONS",
      optimization_goal,
      start_time,
      targeting: typeof targeting === "string" ? targeting : JSON.stringify(targeting),
    };

    const data = await metaPost(`${ad_account_id}/adsets`, params);

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

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error updating campaign status:", error.message);
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

    const data = await metaGet(`${ad_account_id}/campaigns`, {
      fields:
        "id,name,status,daily_budget,lifetime_budget,objective,created_time",
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching live campaigns:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 7. GET /adsets/live — Fetch all ad sets with live status
// ---------------------------------------------------------------------------
router.get("/adsets/live", async (_req: Request, res: Response) => {
  try {
    console.log("[meta-actions] Fetching live ad sets");

    const data = await metaGet(`${ad_account_id}/adsets`, {
      fields:
        "id,name,campaign_id,status,daily_budget,targeting,optimization_goal",
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching live ad sets:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 8. GET /insights/realtime — Today's insights for all campaigns
// ---------------------------------------------------------------------------
router.get("/insights/realtime", async (_req: Request, res: Response) => {
  try {
    console.log("[meta-actions] Fetching realtime insights");

    const data = await metaGet(`${ad_account_id}/insights`, {
      fields:
        "campaign_name,campaign_id,spend,impressions,clicks,actions,cpm,cpc,ctr,frequency",
      date_preset: "today",
      level: "campaign",
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching realtime insights:", error.message);
    res.status(error.status || 500).json({ error: error.message });
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

    const data = await metaGet(`${ad_account_id}/insights`, {
      fields:
        "campaign_name,campaign_id,spend,impressions,clicks,actions,cpm,cpc,ctr,frequency",
      time_range: JSON.stringify({ since, until }),
      level,
      time_increment: "1",
    });

    res.json(data);
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[meta-actions] Error fetching insights range:", error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
