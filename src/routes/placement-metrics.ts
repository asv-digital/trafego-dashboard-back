import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";

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

// NÃO destrutura no module load — resolve via getMetaConfig() por chamada.

interface MetaError {
  error?: { message: string; type: string; code: number };
}

async function metaGet(endpoint: string, params: Record<string, string> = {}) {
  const { access_token } = getMetaConfig();
  if (!access_token) throw new Error("META_ACCESS_TOKEN não configurado");
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
// GET / — Placement breakdown with CPM analysis (Melhoria 22)
// ---------------------------------------------------------------------------
router.get("/", async (req: Request, res: Response) => {
  const period = (req.query.period as string) || "7d";

  const datePresetMap: Record<string, string> = {
    "7d": "last_7d",
    "14d": "last_14d",
    "30d": "last_30d",
  };
  const datePreset = datePresetMap[period] || "last_7d";

  try {
    console.log(`[placement-metrics] Fetching placement breakdown (${datePreset})`);

    const data = await metaGet(`${getMetaConfig().ad_account_id}/insights`, {
      fields: "impressions,spend,cpm,clicks,actions,outbound_clicks",
      breakdowns: "publisher_platform,platform_position",
      date_preset: datePreset,
      level: "account",
    });

    const rows = (data as any).data ?? [];

    const placements = rows.map((row: any) => {
      const impressions = parseInt(row.impressions || "0");
      const spend = parseFloat(row.spend || "0");
      const cpm = parseFloat(row.cpm || "0");
      const clicks = parseInt(row.clicks || "0");

      const outboundClicksArr = row.outbound_clicks || [];
      const outboundClicks = outboundClicksArr.length > 0
        ? parseInt(outboundClicksArr[0].value || "0")
        : 0;

      const actions: any[] = row.actions || [];
      const purchaseAction = actions.find(
        (a: any) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
      );
      const conversions = purchaseAction ? parseInt(purchaseAction.value || "0") : 0;

      const cpa = conversions > 0 ? parseFloat((spend / conversions).toFixed(2)) : null;

      return {
        platform: row.publisher_platform || "unknown",
        position: row.platform_position || "unknown",
        impressions,
        spend: parseFloat(spend.toFixed(2)),
        cpm: parseFloat(cpm.toFixed(2)),
        clicks,
        outboundClicks,
        conversions,
        cpa,
      };
    });

    // Sort by CPA ascending (null CPA goes to end)
    placements.sort((a: any, b: any) => {
      if (a.cpa === null && b.cpa === null) return 0;
      if (a.cpa === null) return 1;
      if (b.cpa === null) return -1;
      return a.cpa - b.cpa;
    });

    // Generate insights
    const insights: string[] = [];
    const withCpa = placements.filter((p: any) => p.cpa !== null);
    const withSpend = placements.filter((p: any) => p.spend > 0);

    if (withCpa.length > 0) {
      const best = withCpa[0];
      insights.push(
        `Melhor CPA: ${best.platform} / ${best.position} com CPA de R$${best.cpa.toFixed(2)}`
      );

      const worst = withCpa[withCpa.length - 1];
      if (withCpa.length > 1) {
        insights.push(
          `Pior CPA: ${worst.platform} / ${worst.position} com CPA de R$${worst.cpa.toFixed(2)}`
        );
      }

      // Suggest exclusions: placements with CPA > 3x the best
      const threshold = best.cpa * 3;
      const toExclude = withCpa.filter((p: any) => p.cpa > threshold);
      if (toExclude.length > 0) {
        const names = toExclude.map((p: any) => `${p.platform}/${p.position}`).join(", ");
        insights.push(
          `Considere excluir posicionamentos com CPA muito alto: ${names}`
        );
      }
    }

    // Placements with spend but no conversions
    const noConversions = withSpend.filter((p: any) => p.conversions === 0 && p.spend > 10);
    if (noConversions.length > 0) {
      const names = noConversions.map((p: any) => `${p.platform}/${p.position}`).join(", ");
      insights.push(
        `Posicionamentos gastando sem conversão: ${names}`
      );
    }

    res.json({ placements, insights });
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[placement-metrics] Error:", error.message);
    res.json({ placements: [], insights: [] });
  }
});

export default router;
