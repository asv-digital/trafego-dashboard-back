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

export default router;
