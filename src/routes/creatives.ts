import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

// GET all creatives
router.get("/", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = {};
  if (req.query.campaignId) where.campaignId = req.query.campaignId as string;

  const creatives = await prisma.creative.findMany({
    where,
    include: { campaign: { select: { id: true, name: true } } },
    orderBy: { cpa: "asc" },
  });

  const now = new Date();
  const enriched = creatives.map((c) => {
    const daysActive = Math.floor((now.getTime() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      ...c,
      daysActive,
      lifetimeAlert: daysActive > 21,
    };
  });

  res.json(enriched);
});

// POST create creative
router.post("/", async (req: Request, res: Response) => {
  const { name, type, status, ctr, hookRate, cpa, campaignId } = req.body;
  const creative = await prisma.creative.create({
    data: {
      name,
      type,
      status: status || "Ativo",
      ctr: ctr ? parseFloat(ctr) : null,
      hookRate: hookRate ? parseFloat(hookRate) : null,
      cpa: cpa ? parseFloat(cpa) : null,
      campaignId,
    },
    include: { campaign: { select: { id: true, name: true } } },
  });
  res.status(201).json(creative);
});

// PATCH update creative
router.patch("/:id", async (req: Request, res: Response) => {
  const data: Record<string, unknown> = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.type !== undefined) data.type = req.body.type;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.ctr !== undefined) data.ctr = parseFloat(req.body.ctr);
  if (req.body.hookRate !== undefined) data.hookRate = parseFloat(req.body.hookRate);
  if (req.body.cpa !== undefined) data.cpa = parseFloat(req.body.cpa);

  const id = req.params.id as string;
  const creative = await prisma.creative.update({
    where: { id },
    data,
    include: { campaign: { select: { id: true, name: true } } },
  });
  res.json(creative);
});

// DELETE creative
router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await prisma.creative.delete({ where: { id } });
  res.status(204).send();
});

export default router;
