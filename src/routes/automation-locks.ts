import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// GET /locks — List active locks
router.get("/locks", async (_req: Request, res: Response) => {
  const locks = await prisma.automationLock.findMany({
    orderBy: { createdAt: "desc" },
  });

  // Mark expired locks
  const now = new Date();
  const enriched = locks.map((lock) => ({
    ...lock,
    isExpired: now > lock.expiresAt,
    expiresIn: Math.max(0, Math.round((lock.expiresAt.getTime() - now.getTime()) / 60000)),
  }));

  res.json({ data: enriched });
});

// DELETE /locks/:id — Release a lock manually
router.delete("/locks/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    await prisma.automationLock.delete({ where: { id } });
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: "Lock não encontrado" });
  }
});

export default router;
