import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

import { NET_PER_SALE } from "../config/constants";

function calcConfidence(
  a: { sales: number; cpa: number },
  b: { sales: number; cpa: number }
): number {
  const totalSales = a.sales + b.sales;
  if (totalSales < 4) return 0;
  const cpaDiff = Math.abs(a.cpa - b.cpa) / Math.max(a.cpa, b.cpa);
  if (totalSales < 10) return Math.min(cpaDiff * 100, 70);
  if (totalSales < 20) return Math.min(cpaDiff * 120 + 20, 85);
  return Math.min(cpaDiff * 150 + 30, 99);
}

// POST /create — Create A/B test
router.post("/create", async (req: Request, res: Response) => {
  const { name, adsetId, variantA, variantB, minDays, minSpendPerVariant } = req.body;

  if (!name || !adsetId || !variantA || !variantB) {
    res.status(400).json({ error: "name, adsetId, variantA e variantB são obrigatórios." });
    return;
  }

  const test = await prisma.creativeTest.create({
    data: {
      name,
      adsetId,
      variantA,
      variantB,
      startDate: new Date(),
      minDays: minDays ? parseInt(minDays) : 5,
      minSpendPerVariant: minSpendPerVariant ? parseFloat(minSpendPerVariant) : 150,
    },
  });

  res.status(201).json(test);
});

// GET /active — List active tests with current metrics
router.get("/active", async (_req: Request, res: Response) => {
  const tests = await prisma.creativeTest.findMany({
    where: { status: "running" },
    orderBy: { createdAt: "desc" },
  });

  const META_BASE = "https://graph.facebook.com/v19.0";
  const metaToken = process.env.META_ACCESS_TOKEN || "";

  const results = await Promise.all(
    tests.map(async (test) => {
      const now = new Date();
      const daysRunning = Math.floor(
        (now.getTime() - test.startDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      const vA = test.variantA as any;
      const vB = test.variantB as any;

      // Fetch insights from Meta for each variant
      const fetchVariantMetrics = async (adId: string) => {
        try {
          const url = new URL(`${META_BASE}/${adId}/insights`);
          url.searchParams.set("access_token", metaToken);
          url.searchParams.set("fields", "spend,impressions,clicks,actions,ctr,cpc");
          url.searchParams.set("date_preset", "last_30d");

          const resp = await fetch(url.toString());
          const data = (await resp.json()) as any;
          const insights = data.data?.[0] || {};

          const spend = parseFloat(insights.spend || "0");
          const impressions = parseInt(insights.impressions || "0");
          const clicks = parseInt(insights.clicks || "0");
          const actions: any[] = insights.actions || [];
          const purchaseAction = actions.find(
            (a: any) =>
              a.action_type === "purchase" ||
              a.action_type === "offsite_conversion.fb_pixel_purchase"
          );
          const sales = purchaseAction ? parseInt(purchaseAction.value || "0") : 0;
          const cpa = sales > 0 ? spend / sales : spend > 0 ? 999 : 0;
          const roas = spend > 0 ? (sales * NET_PER_SALE) / spend : 0;

          return { spend, impressions, clicks, sales, cpa, roas };
        } catch {
          return { spend: 0, impressions: 0, clicks: 0, sales: 0, cpa: 0, roas: 0 };
        }
      };

      const [metricsA, metricsB] = await Promise.all([
        fetchVariantMetrics(vA.adId),
        fetchVariantMetrics(vB.adId),
      ]);

      const confidence = calcConfidence(
        { sales: metricsA.sales, cpa: metricsA.cpa },
        { sales: metricsB.sales, cpa: metricsB.cpa }
      );

      const preliminaryWinner =
        metricsA.cpa > 0 && metricsB.cpa > 0
          ? metricsA.cpa <= metricsB.cpa
            ? "variantA"
            : "variantB"
          : metricsA.sales > metricsB.sales
            ? "variantA"
            : metricsB.sales > metricsA.sales
              ? "variantB"
              : null;

      const readyToDecide =
        confidence >= 90 &&
        daysRunning >= test.minDays &&
        metricsA.spend >= test.minSpendPerVariant &&
        metricsB.spend >= test.minSpendPerVariant;

      let verdict: string;
      if (readyToDecide && preliminaryWinner) {
        const winnerName = preliminaryWinner === "variantA" ? vA.name : vB.name;
        verdict = `Pronto para decisão. ${winnerName} é o vencedor preliminar com ${confidence.toFixed(0)}% de confiança.`;
      } else if (confidence >= 70) {
        verdict = `Tendência clara, mas aguarde mais dados (${confidence.toFixed(0)}% confiança).`;
      } else {
        verdict = `Teste em andamento. ${daysRunning} dias, ${(metricsA.sales + metricsB.sales)} vendas totais. Precisa de mais dados.`;
      }

      return {
        id: test.id,
        name: test.name,
        adset_id: test.adsetId,
        days_running: daysRunning,
        min_days: test.minDays,
        min_spend_per_variant: test.minSpendPerVariant,
        variant_a: {
          ad_id: vA.adId,
          name: vA.name,
          ...metricsA,
          cpa: parseFloat(metricsA.cpa.toFixed(2)),
          roas: parseFloat(metricsA.roas.toFixed(2)),
        },
        variant_b: {
          ad_id: vB.adId,
          name: vB.name,
          ...metricsB,
          cpa: parseFloat(metricsB.cpa.toFixed(2)),
          roas: parseFloat(metricsB.roas.toFixed(2)),
        },
        confidence: parseFloat(confidence.toFixed(1)),
        preliminary_winner: preliminaryWinner,
        ready_to_decide: readyToDecide,
        verdict,
      };
    })
  );

  res.json(results);
});

// POST /:id/decide — Mark winner
router.post("/:id/decide", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { winner } = req.body;

  if (!winner || !["variantA", "variantB"].includes(winner)) {
    res.status(400).json({ error: 'winner deve ser "variantA" ou "variantB".' });
    return;
  }

  try {
    const test = await prisma.creativeTest.findUnique({ where: { id } });
    if (!test) {
      res.status(404).json({ error: "Teste não encontrado." });
      return;
    }

    const updated = await prisma.creativeTest.update({
      where: { id },
      data: {
        winner,
        confidence: test.confidence,
        decidedAt: new Date(),
        status: "decided",
      },
    });

    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Erro ao decidir teste.", details: message });
  }
});

export default router;
