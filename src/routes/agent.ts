import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getStatus, runNow } from "../agent/scheduler";
import type { AgentConfig } from "../agent/types";

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
  try {
    const configPath = path.resolve(__dirname, "../../agent-config.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const config: AgentConfig = JSON.parse(raw);

    // Return only business settings — never expose tokens
    res.json({
      business: config.business,
      meta: {
        ad_account_id: config.meta.ad_account_id,
        configured:
          config.meta.access_token !== "COLE_SEU_TOKEN_AQUI" &&
          config.meta.ad_account_id !== "act_XXXXXXXXXX",
      },
      kirvano: {
        configured:
          config.kirvano.api_key !== "COLE_SUA_API_KEY_AQUI" &&
          config.kirvano.api_key !== "",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
