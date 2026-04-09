import { Router, Request, Response } from "express";
import { getLookalikeStatus } from "../services/audience-builder";

const router = Router();

// GET /lookalikes — Lookalike audience status
router.get("/lookalikes", async (_req: Request, res: Response) => {
  try {
    const status = await getLookalikeStatus();
    res.json(status);
  } catch (err: unknown) {
    console.error("[audiences] Error:", (err as Error).message);
    res.json({ buyer_count: 0, next_milestone: 100, buyers_until_next: 100, lookalikes: [] });
  }
});

export default router;
