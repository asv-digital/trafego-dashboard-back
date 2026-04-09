import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// GET /summary — Comment summaries for all ads
router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const summaries = await prisma.adCommentSummary.findMany({
      orderBy: { analyzedAt: "desc" },
    });
    res.json({ data: summaries });
  } catch (err: unknown) {
    console.error("[comments] Error:", (err as Error).message);
    res.json({ data: [] });
  }
});

// GET /by-ad/:adId — All comments for a specific ad
router.get("/by-ad/:adId", async (req: Request, res: Response) => {
  try {
    const adId = req.params.adId as string;
    const comments = await prisma.adComment.findMany({
      where: { adId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ data: comments });
  } catch (err: unknown) {
    console.error("[comments] Error:", (err as Error).message);
    res.json({ data: [] });
  }
});

export default router;
