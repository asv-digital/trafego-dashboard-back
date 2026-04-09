import { Router, Request, Response } from "express";
import { getStatus, runNow } from "../agent/scheduler";

const router = Router();

// GET /api/agent/status — scheduler status
router.get("/status", (_req: Request, res: Response) => {
  const status = getStatus();
  res.json(status);
});

// POST /api/agent/run — trigger immediate collection
router.post("/run", async (_req: Request, res: Response) => {
  try {
    const result = await runNow();
    res.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/agent/config — business config (no sensitive tokens)
router.get("/config", (_req: Request, res: Response) => {
  const metaToken = process.env.META_ACCESS_TOKEN || "";
  const metaAccount = process.env.META_AD_ACCOUNT_ID || "";
  const kirvanoKey = process.env.KIRVANO_API_KEY || "";

  res.json({
    business: {
      product_name: "56 Skills de Claude Code",
      product_price: 97,
      gateway_fee_percent: 3.5,
      net_revenue_per_sale: 93.6,
      daily_budget_target: Number(process.env.DAILY_BUDGET_TARGET) || 500,
      cpa_target: Number(process.env.CPA_TARGET) || 50,
      cpa_alert: Number(process.env.CPA_ALERT) || 70,
      roas_target: Number(process.env.ROAS_TARGET) || 2.0,
      roas_alert: Number(process.env.ROAS_ALERT) || 1.4,
    },
    meta: {
      ad_account_id: metaAccount,
      configured: metaToken !== "" && metaAccount !== "",
    },
    kirvano: {
      configured: kirvanoKey !== "",
    },
  });
});

// GET /api/agent/token-status — Meta token expiration status (Melhoria 6)
router.get("/token-status", (_req: Request, res: Response) => {
  const createdAtStr = process.env.META_TOKEN_CREATED_AT;
  if (!createdAtStr) {
    res.status(400).json({ error: "META_TOKEN_CREATED_AT not configured" });
    return;
  }

  const createdAt = new Date(createdAtStr);
  const expiresAt = new Date(createdAt);
  expiresAt.setDate(expiresAt.getDate() + 60);

  const now = new Date();
  const daysRemaining = Math.floor(
    (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  let status: "ok" | "warning" | "critical" | "expired";
  let message: string;

  if (daysRemaining < 0) {
    status = "expired";
    message = `Token expirou há ${Math.abs(daysRemaining)} dias. Renove imediatamente.`;
  } else if (daysRemaining < 7) {
    status = "critical";
    message = `Token expira em ${daysRemaining} dias. Renovação urgente necessária.`;
  } else if (daysRemaining <= 14) {
    status = "warning";
    message = `Token expira em ${daysRemaining} dias. Planeje a renovação.`;
  } else {
    status = "ok";
    message = `Token válido por mais ${daysRemaining} dias.`;
  }

  res.json({
    token_created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    days_remaining: daysRemaining,
    status,
    message,
  });
});

// POST /api/agent/refresh-token — Exchange token via Meta API (Melhoria 6)
router.post("/refresh-token", async (_req: Request, res: Response) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const currentToken = process.env.META_ACCESS_TOKEN;

  if (!appId || !appSecret || !currentToken) {
    res.status(400).json({
      error: "META_APP_ID, META_APP_SECRET, and META_ACCESS_TOKEN must be configured",
    });
    return;
  }

  try {
    const url =
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${appId}` +
      `&client_secret=${appSecret}` +
      `&fb_exchange_token=${currentToken}`;

    const response = await fetch(url);
    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      res.status(response.status).json({
        error: "Meta API error",
        details: data,
      });
      return;
    }

    res.json({
      success: true,
      new_token: data.access_token,
      token_type: data.token_type,
      expires_in_seconds: data.expires_in,
      note: "Token retornado para atualização manual no .env. Não é possível atualizar variáveis de ambiente em runtime.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to refresh token", details: message });
  }
});

// GET /api/agent/event-match-quality — EMQ score from Meta or estimated
router.get("/event-match-quality", async (_req: Request, res: Response) => {
  const pixelId = process.env.META_PIXEL_ID || "";
  const token = process.env.META_ACCESS_TOKEN || "";

  const thresholds = { good: 6.0, warning: 4.0 };

  try {
    if (!pixelId || !token) {
      throw new Error("META_PIXEL_ID or META_ACCESS_TOKEN not configured");
    }

    // Try to get EMQ from Meta API
    const url = `https://graph.facebook.com/v19.0/${pixelId}?fields=data_use_setting,event_match_quality&access_token=${token}`;
    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.error) {
      throw new Error(data.error.message);
    }

    if (data.event_match_quality) {
      const score = parseFloat(data.event_match_quality);
      let status: "good" | "warning" | "critical";
      if (score >= thresholds.good) {
        status = "good";
      } else if (score >= thresholds.warning) {
        status = "warning";
      } else {
        status = "critical";
      }

      res.json({
        score,
        status,
        details: status === "good"
          ? `EMQ de ${score.toFixed(1)}/10. Excelente qualidade de match.`
          : status === "warning"
          ? `EMQ de ${score.toFixed(1)}/10. Melhorar envio de email e telefone via CAPI.`
          : `EMQ de ${score.toFixed(1)}/10. Qualidade crítica. Revisar integração CAPI urgentemente.`,
        source: "meta_api",
        thresholds,
      });
      return;
    }

    // If no EMQ field returned, fall through to estimation
    throw new Error("EMQ field not available from Meta API");
  } catch (err) {
    // Fallback: estimate based on recent CAPI sales from DB
    try {
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const recentSales = await prisma.sale.findMany({
        where: { date: { gte: sevenDaysAgo } },
      });

      await prisma.$disconnect();

      const total = recentSales.length;
      if (total === 0) {
        res.json({
          score: 0,
          status: "critical" as const,
          details: "Sem vendas recentes para estimar EMQ.",
          source: "estimated",
          thresholds,
        });
        return;
      }

      const withEmail = recentSales.filter((s: any) => s.email && s.email.trim() !== "").length;
      const withPhone = recentSales.filter((s: any) => s.phone && s.phone.trim() !== "").length;

      const emailRate = withEmail / total;
      const phoneRate = withPhone / total;
      const estimatedScore = parseFloat(((emailRate * 5 + phoneRate * 3 + 2) * 1).toFixed(1));
      const clampedScore = Math.min(estimatedScore, 10);

      let status: "good" | "warning" | "critical";
      if (clampedScore >= thresholds.good) {
        status = "good";
      } else if (clampedScore >= thresholds.warning) {
        status = "warning";
      } else {
        status = "critical";
      }

      res.json({
        score: clampedScore,
        status,
        details: `Estimativa baseada em ${total} vendas recentes. ${(emailRate * 100).toFixed(0)}% com email, ${(phoneRate * 100).toFixed(0)}% com telefone.`,
        source: "estimated",
        thresholds,
      });
    } catch (dbErr) {
      const message = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error("[agent] EMQ estimation error:", message);
      res.json({
        score: 0,
        status: "critical" as const,
        details: `Não foi possível obter EMQ. Erro: ${message}`,
        source: "error",
        thresholds,
      });
    }
  }
});

export default router;
