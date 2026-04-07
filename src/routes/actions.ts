import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// ---------------------------------------------------------------------------
// Helper — log an action (exported for use in other routes)
// ---------------------------------------------------------------------------

export async function logAction(params: {
  action: string;
  entityType: string;
  entityId: string;
  entityName: string;
  details?: string;
  source?: string;
}) {
  await prisma.actionLog.create({
    data: { ...params, source: params.source || "dashboard" },
  });
}

// ---------------------------------------------------------------------------
// GET /log — List action logs (Melhoria 17)
// ---------------------------------------------------------------------------

router.get("/log", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 500);
  const entityType = req.query.entityType as string | undefined;

  const where: Record<string, unknown> = {};
  if (entityType) where.entityType = entityType;

  const logs = await prisma.actionLog.findMany({
    where,
    orderBy: { executedAt: "desc" },
    take: limit,
  });

  res.json({ data: logs, limit });
});

export default router;
