import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { PRODUCT_PRICE, NET_PER_SALE } from "../config/constants";

const router = Router();

// GET all metrics (with computed fields)
router.get("/", async (req: Request, res: Response) => {
  const where: Record<string, unknown> = {};
  if (req.query.campaignId) where.campaignId = req.query.campaignId as string;

  const metrics = await prisma.metricEntry.findMany({
    where,
    include: { campaign: { select: { id: true, name: true } } },
    orderBy: { date: "desc" },
  });

  const enriched = metrics.map((m) => ({
    ...m,
    cpm: m.impressions > 0 ? (m.investment / m.impressions) * 1000 : null,
    cpc: m.clicks > 0 ? m.investment / m.clicks : null,
    ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null,
    cpa: m.sales > 0 ? m.investment / m.sales : null,
    roas: m.investment > 0 ? (m.sales * NET_PER_SALE) / m.investment : null,
    revenue: m.sales * NET_PER_SALE,
  }));

  res.json(enriched);
});

// POST create metric entry
router.post("/", async (req: Request, res: Response) => {
  const { date, campaignId, adSet, investment, impressions, clicks, sales, frequency, hookRate, observations } = req.body;

  const metric = await prisma.metricEntry.create({
    data: {
      date: new Date(date),
      campaignId,
      adSet,
      investment: parseFloat(investment),
      impressions: parseInt(impressions),
      clicks: parseInt(clicks),
      sales: parseInt(sales),
      frequency: frequency ? parseFloat(frequency) : null,
      hookRate: hookRate ? parseFloat(hookRate) : null,
      observations,
    },
    include: { campaign: { select: { id: true, name: true } } },
  });

  res.status(201).json(metric);
});

// DELETE metric entry
router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await prisma.metricEntry.delete({ where: { id } });
  res.status(204).send();
});

// GET overview/KPIs (Melhoria 9: period + compare support)
router.get("/overview", async (req: Request, res: Response) => {
  const periodParam = (req.query.period as string) || "7d";
  const compare = req.query.compare as string | undefined;
  const startParam = req.query.start as string | undefined;
  const endParam = req.query.end as string | undefined;
  const compareStartParam = req.query.compare_start as string | undefined;
  const compareEndParam = req.query.compare_end as string | undefined;

  const now = new Date();
  let currentStart: Date;
  let currentEnd: Date = now;

  if (periodParam === "custom" && startParam && endParam) {
    currentStart = new Date(startParam);
    currentEnd = new Date(endParam);
  } else if (periodParam === "month") {
    currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    const periodDays = periodParam === "30d" ? 30 : periodParam === "14d" ? 14 : 7;
    currentStart = new Date(now);
    currentStart.setDate(currentStart.getDate() - periodDays);
  }

  const computeOverview = (metrics: { investment: number; sales: number; clicks: number; impressions: number }[]) => {
    const totalInvestment = metrics.reduce((s, m) => s + m.investment, 0);
    const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
    const totalClicks = metrics.reduce((s, m) => s + m.clicks, 0);
    const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);
    const totalRevenue = totalSales * NET_PER_SALE;
    return {
      totalInvestment,
      totalRevenue,
      totalSales,
      totalClicks,
      totalImpressions,
      roas: totalInvestment > 0 ? totalRevenue / totalInvestment : 0,
      cpa: totalSales > 0 ? totalInvestment / totalSales : 0,
      conversionRate: totalClicks > 0 ? (totalSales / totalClicks) * 100 : 0,
    };
  };

  const currentMetrics = await prisma.metricEntry.findMany({
    where: { date: { gte: currentStart, lte: currentEnd } },
  });

  const current = computeOverview(currentMetrics);

  if (compare === "previous" || compare === "custom") {
    let previousStart: Date;
    let previousEnd: Date;

    if (compare === "custom" && compareStartParam && compareEndParam) {
      previousStart = new Date(compareStartParam);
      previousEnd = new Date(compareEndParam);
    } else {
      // Auto-compute previous period of same length
      const periodLengthMs = currentEnd.getTime() - currentStart.getTime();
      previousEnd = new Date(currentStart.getTime() - 1);
      previousStart = new Date(previousEnd.getTime() - periodLengthMs);
    }

    const previousMetrics = await prisma.metricEntry.findMany({
      where: { date: { gte: previousStart, lte: previousEnd } },
    });

    const previous = computeOverview(previousMetrics);

    const calcVariation = (curr: number, prev: number) =>
      prev !== 0 ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : curr > 0 ? 100 : 0;

    const variation = {
      totalInvestment: calcVariation(current.totalInvestment, previous.totalInvestment),
      totalRevenue: calcVariation(current.totalRevenue, previous.totalRevenue),
      totalSales: calcVariation(current.totalSales, previous.totalSales),
      totalClicks: calcVariation(current.totalClicks, previous.totalClicks),
      totalImpressions: calcVariation(current.totalImpressions, previous.totalImpressions),
      roas: calcVariation(current.roas, previous.roas),
      cpa: calcVariation(current.cpa, previous.cpa),
      conversionRate: calcVariation(current.conversionRate, previous.conversionRate),
    };

    res.json({ current, previous, variation });
  } else {
    res.json(current);
  }
});

// GET /score — Operation score 0-100 (Melhoria 10)
router.get("/score", async (req: Request, res: Response) => {
  const periodParam = (req.query.period as string) || "7d";
  const periodDays = periodParam === "30d" ? 30 : periodParam === "14d" ? 14 : 7;

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - periodDays);

  const metrics = await prisma.metricEntry.findMany({
    where: { date: { gte: start, lte: now } },
  });

  const totalInvestment = metrics.reduce((s, m) => s + m.investment, 0);
  const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
  const totalClicks = metrics.reduce((s, m) => s + m.clicks, 0);
  const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);

  const cpa = totalSales > 0 ? totalInvestment / totalSales : 999;
  const roas = totalInvestment > 0 ? (totalSales * NET_PER_SALE) / totalInvestment : 0;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  const freqValues = metrics.filter((m) => m.frequency != null).map((m) => m.frequency!);
  const avgFrequency = freqValues.length > 0 ? freqValues.reduce((s, v) => s + v, 0) / freqValues.length : 0;

  const hookValues = metrics.filter((m) => m.hookRate != null).map((m) => m.hookRate!);
  const avgHookRate = hookValues.length > 0 ? hookValues.reduce((s, v) => s + v, 0) / hookValues.length : 0;

  // Creative health: fetch creatives with CPA
  const creatives = await prisma.creative.findMany({
    where: { cpa: { not: null } },
  });
  const healthyCreatives = creatives.filter((c) => c.cpa! < 50).length;
  const creativeHealthPct = creatives.length > 0 ? (healthyCreatives / creatives.length) * 100 : 0;

  // Score calculations
  const cpaScore = cpa < 50 ? 100 : cpa < 70 ? 60 : cpa < PRODUCT_PRICE ? 30 : 0;
  const roasScore = roas > 2.5 ? 100 : roas > 2.0 ? 80 : roas > 1.4 ? 50 : roas > 1.0 ? 20 : 0;
  const ctrScore = ctr > 2.0 ? 100 : ctr > 1.5 ? 70 : ctr > 0.8 ? 40 : 0;
  const freqScore = avgFrequency < 2 ? 100 : avgFrequency < 3 ? 70 : avgFrequency < 5 ? 40 : 0;
  const hookScore = avgHookRate > 30 ? 100 : avgHookRate > 25 ? 70 : avgHookRate > 18 ? 40 : 0;
  const creativeScore = creativeHealthPct;

  const score = Math.round(
    cpaScore * 0.25 +
    roasScore * 0.25 +
    ctrScore * 0.10 +
    freqScore * 0.15 +
    hookScore * 0.10 +
    creativeScore * 0.15
  );

  let status: string;
  let color: string;
  if (score >= 80) { status = "Excelente"; color = "#50c878"; }
  else if (score >= 60) { status = "Bom"; color = "#5b9bd5"; }
  else if (score >= 40) { status = "Atenção"; color = "#f0c040"; }
  else { status = "Crítico"; color = "#e85040"; }

  const breakdown = [
    { metric: "CPA", value: parseFloat(cpa.toFixed(2)), score: cpaScore, weight: 0.25 },
    { metric: "ROAS", value: parseFloat(roas.toFixed(2)), score: roasScore, weight: 0.25 },
    { metric: "CTR", value: parseFloat(ctr.toFixed(2)), score: ctrScore, weight: 0.10 },
    { metric: "Frequência", value: parseFloat(avgFrequency.toFixed(2)), score: freqScore, weight: 0.15 },
    { metric: "Hook Rate", value: parseFloat(avgHookRate.toFixed(2)), score: hookScore, weight: 0.10 },
    { metric: "Saúde dos Criativos", value: parseFloat(creativeHealthPct.toFixed(1)), score: Math.round(creativeScore), weight: 0.15 },
  ];

  const summaryParts: string[] = [];
  if (cpaScore <= 30) summaryParts.push(`CPA alto (R$${cpa.toFixed(2)}), precisa otimizar`);
  if (roasScore <= 20) summaryParts.push(`ROAS baixo (${roas.toFixed(2)}x), receita não cobre investimento`);
  if (freqScore <= 40) summaryParts.push(`Frequência alta (${avgFrequency.toFixed(1)}), público saturado`);
  if (hookScore <= 40) summaryParts.push(`Hook Rate baixo (${avgHookRate.toFixed(1)}%), criativos não prendem`);
  if (creativeHealthPct < 50) summaryParts.push(`${(100 - creativeHealthPct).toFixed(0)}% dos criativos com CPA acima do ideal`);
  if (summaryParts.length === 0) summaryParts.push("Operação saudável, manter estratégia atual");

  res.json({ score, status, color, breakdown, summary: summaryParts.join(". ") + "." });
});

// ---------------------------------------------------------------------------
// GET /frequency-by-adset — Frequency analysis per adset (Melhoria 23)
// ---------------------------------------------------------------------------
router.get("/frequency-by-adset", async (req: Request, res: Response) => {
  const META_BASE = "https://graph.facebook.com/v19.0";
  const metaToken = process.env.META_ACCESS_TOKEN || "";
  const metaAccountId = process.env.META_AD_ACCOUNT_ID || "";

  const period = (req.query.period as string) || "7d";
  const datePresetMap: Record<string, string> = {
    "7d": "last_7d",
    "14d": "last_14d",
    "30d": "last_30d",
  };
  const datePreset = datePresetMap[period] || "last_7d";

  const thresholds = {
    hot: { saturated: 3.0, watch: 2.0, label: "Remarketing" },
    lookalike: { saturated: 2.5, watch: 1.8, label: "Lookalike" },
    cold: { saturated: 2.0, watch: 1.5, label: "Cold/Prospecção" },
  };

  try {
    const url = new URL(`${META_BASE}/${metaAccountId}/insights`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "adset_name,adset_id,frequency,reach,impressions,spend,actions");
    url.searchParams.set("level", "adset");
    url.searchParams.set("date_preset", datePreset);

    const response = await fetch(url.toString());
    const data = (await response.json()) as any;

    if (data.error) {
      throw { status: response.status, message: data.error.message };
    }

    const rows: any[] = data.data ?? [];

    const adsets = rows.map((row: any) => {
      const name: string = row.adset_name || "";
      const frequency = parseFloat(row.frequency || "0");
      const reach = parseInt(row.reach || "0");
      const impressions = parseInt(row.impressions || "0");
      const spend = parseFloat(row.spend || "0");

      const actions: any[] = row.actions || [];
      const purchaseAction = actions.find(
        (a: any) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
      );
      const conversions = purchaseAction ? parseInt(purchaseAction.value || "0") : 0;

      const upperName = name.toUpperCase();
      let audienceType: "hot" | "lookalike" | "cold";
      if (upperName.includes("RMK") || upperName.includes("REMARKETING")) {
        audienceType = "hot";
      } else if (upperName.includes("LAL") || upperName.includes("LOOKALIKE")) {
        audienceType = "lookalike";
      } else {
        audienceType = "cold";
      }

      const t = thresholds[audienceType];
      let freqStatus: string;
      let freqColor: string;
      if (frequency > t.saturated) {
        freqStatus = "saturated";
        freqColor = "#e85040";
      } else if (frequency >= t.watch) {
        freqStatus = "watch";
        freqColor = "#f0c040";
      } else {
        freqStatus = "healthy";
        freqColor = "#50c878";
      }

      return {
        adset_id: row.adset_id,
        adset_name: name,
        audience_type: audienceType,
        frequency: parseFloat(frequency.toFixed(2)),
        reach,
        impressions,
        spend: parseFloat(spend.toFixed(2)),
        conversions,
        freq_status: freqStatus,
        freq_color: freqColor,
        threshold_saturated: t.saturated,
        threshold_watch: t.watch,
      };
    });

    // Sort: saturated first, then watch, then healthy
    const statusOrder: Record<string, number> = { saturated: 0, watch: 1, healthy: 2 };
    adsets.sort((a, b) => (statusOrder[a.freq_status] ?? 3) - (statusOrder[b.freq_status] ?? 3));

    res.json({ adsets, thresholds });
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[metrics] Error fetching frequency by adset:", error.message);
    res.json({ adsets: [], thresholds });
  }
});

// ---------------------------------------------------------------------------
// GET /scaling-rules — Scaling recommendations per campaign (Melhoria 24)
// ---------------------------------------------------------------------------
router.get("/scaling-rules", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const campaigns = await prisma.campaign.findMany({
      include: {
        metrics: {
          where: { date: { gte: threeDaysAgo, lte: now } },
          orderBy: { date: "desc" },
        },
      },
    });

    const priorityOrder: Record<string, number> = {
      critical: 0,
      danger: 1,
      warning: 2,
      success: 3,
    };

    const recommendations = campaigns
      .map((campaign) => {
        const metrics = campaign.metrics;
        if (metrics.length === 0) return null;

        const totalSpend = metrics.reduce((s, m) => s + m.investment, 0);
        const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
        const avgCpa = totalSales > 0 ? totalSpend / totalSales : totalSpend > 0 ? 999 : 0;
        const totalClicks = metrics.reduce((s, m) => s + m.clicks, 0);
        const totalImpressions = metrics.reduce((s, m) => s + m.impressions, 0);
        const daysWithData = metrics.length;

        let action: string;
        let priority: string;
        let message: string;

        if (totalSpend > 200 && totalSales === 0) {
          action = "kill";
          priority = "critical";
          message = `R$${totalSpend.toFixed(2)} gastos sem nenhuma venda em ${daysWithData} dias. Pausar imediatamente.`;
        } else if (avgCpa > 70) {
          action = "consider_pause";
          priority = "danger";
          message = `CPA médio de R$${avgCpa.toFixed(2)} nos últimos ${daysWithData} dias. Considere pausar ou ajustar.`;
        } else if (avgCpa >= 50 && avgCpa <= 70) {
          action = "watch";
          priority = "warning";
          message = `CPA médio de R$${avgCpa.toFixed(2)}. Monitorar de perto antes de escalar.`;
        } else if (avgCpa < 50 && totalSales >= 3) {
          action = "scale_up";
          priority = "success";
          message = `CPA de R$${avgCpa.toFixed(2)} com ${totalSales} vendas. Candidata a escalar (+20% budget).`;
        } else {
          action = "watch";
          priority = "warning";
          message = `CPA de R$${avgCpa.toFixed(2)} com ${totalSales} venda(s). Aguardar mais dados.`;
        }

        return {
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          status: campaign.status,
          days_analyzed: daysWithData,
          total_spend: parseFloat(totalSpend.toFixed(2)),
          total_sales: totalSales,
          total_clicks: totalClicks,
          total_impressions: totalImpressions,
          avg_cpa: parseFloat(avgCpa.toFixed(2)),
          action,
          priority,
          message,
        };
      })
      .filter(Boolean);

    // Sort by priority (critical first)
    recommendations.sort(
      (a, b) => (priorityOrder[a!.priority] ?? 99) - (priorityOrder[b!.priority] ?? 99)
    );

    res.json(recommendations);
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[metrics] Error computing scaling rules:", error.message);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// GET /asc-performance — ASC vs ABO comparison (Melhoria 25)
// ---------------------------------------------------------------------------
router.get("/asc-performance", async (_req: Request, res: Response) => {
  const META_BASE = "https://graph.facebook.com/v19.0";
  const metaToken = process.env.META_ACCESS_TOKEN || "";
  const metaAccountId = process.env.META_AD_ACCOUNT_ID || "";

  try {
    // 1. Fetch campaigns from Meta
    const campaignsUrl = new URL(`${META_BASE}/${metaAccountId}/campaigns`);
    campaignsUrl.searchParams.set("access_token", metaToken);
    campaignsUrl.searchParams.set("fields", "id,name,status,daily_budget,objective,buying_type");
    campaignsUrl.searchParams.set("limit", "200");

    const campaignsResp = await fetch(campaignsUrl.toString());
    const campaignsData = (await campaignsResp.json()) as any;

    if (campaignsData.error) {
      throw { status: campaignsResp.status, message: campaignsData.error.message };
    }

    const allCampaigns: any[] = campaignsData.data ?? [];

    // 2. Filter ASC campaigns
    const ascCampaigns = allCampaigns.filter((c: any) => {
      const name = (c.name || "").toUpperCase();
      return c.objective === "OUTCOME_SALES" || name.includes("ASC");
    });

    // 3. Fetch 7-day insights for each ASC campaign
    const ascResults = await Promise.all(
      ascCampaigns.map(async (campaign: any) => {
        const insightsUrl = new URL(`${META_BASE}/${campaign.id}/insights`);
        insightsUrl.searchParams.set("access_token", metaToken);
        insightsUrl.searchParams.set("fields", "spend,impressions,clicks,actions,cpm,ctr,cpc");
        insightsUrl.searchParams.set("date_preset", "last_7d");

        const insResp = await fetch(insightsUrl.toString());
        const insData = (await insResp.json()) as any;

        const insights = insData.data?.[0] || {};
        const actions: any[] = insights.actions || [];
        const purchaseAction = actions.find(
          (a: any) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
        );
        const conversions = purchaseAction ? parseInt(purchaseAction.value || "0") : 0;
        const spend = parseFloat(insights.spend || "0");

        // Try to get audience_segment_type breakdown for new vs existing customers
        let new_customers_percent: number | null = null;
        let existing_customers_percent: number | null = null;
        try {
          const breakdownUrl = new URL(`${META_BASE}/${campaign.id}/insights`);
          breakdownUrl.searchParams.set("access_token", metaToken);
          breakdownUrl.searchParams.set("fields", "spend,actions");
          breakdownUrl.searchParams.set("date_preset", "last_7d");
          breakdownUrl.searchParams.set("breakdowns", "audience_segment_type");

          const bdResp = await fetch(breakdownUrl.toString());
          const bdData = (await bdResp.json()) as any;
          const bdRows: any[] = bdData.data ?? [];

          if (bdRows.length > 0) {
            let newSpend = 0;
            let existingSpend = 0;
            for (const row of bdRows) {
              const segSpend = parseFloat(row.spend || "0");
              const segment = (row.audience_segment_type || "").toLowerCase();
              if (segment.includes("new") || segment === "new_users") {
                newSpend += segSpend;
              } else if (segment.includes("existing") || segment === "existing_users") {
                existingSpend += segSpend;
              }
            }
            const totalSegSpend = newSpend + existingSpend;
            if (totalSegSpend > 0) {
              new_customers_percent = parseFloat(((newSpend / totalSegSpend) * 100).toFixed(1));
              existing_customers_percent = parseFloat(((existingSpend / totalSegSpend) * 100).toFixed(1));
            }
          }
        } catch {
          // Breakdown not supported for this campaign, keep nulls
        }

        return {
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          status: campaign.status,
          daily_budget: campaign.daily_budget ? parseFloat(campaign.daily_budget) / 100 : null,
          objective: campaign.objective,
          buying_type: campaign.buying_type,
          spend_7d: parseFloat(spend.toFixed(2)),
          impressions_7d: parseInt(insights.impressions || "0"),
          clicks_7d: parseInt(insights.clicks || "0"),
          conversions_7d: conversions,
          cpa_7d: conversions > 0 ? parseFloat((spend / conversions).toFixed(2)) : null,
          cpm_7d: insights.cpm ? parseFloat(parseFloat(insights.cpm).toFixed(2)) : null,
          ctr_7d: insights.ctr ? parseFloat(parseFloat(insights.ctr).toFixed(2)) : null,
          new_customers_percent,
          existing_customers_percent,
        };
      })
    );

    // 4. Compare with ABO campaigns from database (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const aboCampaigns = await prisma.campaign.findMany({
      include: {
        metrics: {
          where: { date: { gte: sevenDaysAgo } },
        },
      },
    });

    const aboTotalSpend = aboCampaigns.reduce(
      (s, c) => s + c.metrics.reduce((ms, m) => ms + m.investment, 0), 0
    );
    const aboTotalSales = aboCampaigns.reduce(
      (s, c) => s + c.metrics.reduce((ms, m) => ms + m.sales, 0), 0
    );
    const aboCpa = aboTotalSales > 0 ? aboTotalSpend / aboTotalSales : null;

    const ascTotalSpend = ascResults.reduce((s, r) => s + r.spend_7d, 0);
    const ascTotalConversions = ascResults.reduce((s, r) => s + r.conversions_7d, 0);
    const ascCpa = ascTotalConversions > 0 ? ascTotalSpend / ascTotalConversions : null;

    let summary = "";
    if (ascResults.length === 0) {
      summary = "Nenhuma campanha ASC encontrada na conta.";
    } else if (ascCpa !== null && aboCpa !== null) {
      const diff = ((ascCpa - aboCpa) / aboCpa) * 100;
      if (diff < -10) {
        summary = `ASC performando ${Math.abs(diff).toFixed(0)}% melhor que ABO em CPA. Considere escalar ASC.`;
      } else if (diff > 10) {
        summary = `ABO performando ${diff.toFixed(0)}% melhor que ASC em CPA. Manter foco em ABO.`;
      } else {
        summary = `Performance similar entre ASC e ABO (diferença de ${Math.abs(diff).toFixed(0)}%).`;
      }
    } else {
      summary = `${ascResults.length} campanha(s) ASC encontrada(s). Dados insuficientes para comparação completa.`;
    }

    res.json({
      asc_campaigns: ascResults,
      abo_summary: {
        total_spend_7d: parseFloat(aboTotalSpend.toFixed(2)),
        total_sales_7d: aboTotalSales,
        avg_cpa_7d: aboCpa !== null ? parseFloat(aboCpa.toFixed(2)) : null,
      },
      summary,
    });
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.error("[metrics] Error fetching ASC performance:", error.message);
    res.json({ asc_campaigns: [], summary: "Sem dados ASC disponíveis." });
  }
});

// ---------------------------------------------------------------------------
// GET /budget-rebalance — Budget rebalance recommendations (Melhoria 29)
// ---------------------------------------------------------------------------
router.get("/budget-rebalance", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const campaigns = await prisma.campaign.findMany({
      where: { status: "Ativa" },
      include: {
        metrics: {
          where: { date: { gte: sevenDaysAgo, lte: now } },
          orderBy: { date: "desc" },
        },
      },
    });

    const recommendations = campaigns
      .map((campaign) => {
        const metrics = campaign.metrics;
        if (metrics.length === 0) return null;

        const totalSpend = metrics.reduce((s, m) => s + m.investment, 0);
        const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
        const avgCpa = totalSales > 0 ? totalSpend / totalSales : totalSpend > 0 ? 999 : 0;
        const dailyBudget = campaign.dailyBudget;

        let suggestedBudget: number;
        let action: string;
        let reason: string;

        if (avgCpa < 50 && totalSales >= 3) {
          // Top performer: +30%
          suggestedBudget = parseFloat((dailyBudget * 1.3).toFixed(2));
          action = "increase";
          reason = `CPA de R$${avgCpa.toFixed(2)} com ${totalSales} vendas. Top performer, aumentar 30%.`;
        } else if (avgCpa > 70 && totalSales > 0) {
          // Underperformer: -40%
          suggestedBudget = parseFloat((dailyBudget * 0.6).toFixed(2));
          action = "decrease";
          reason = `CPA de R$${avgCpa.toFixed(2)} acima do ideal. Reduzir 40%.`;
        } else if (totalSales === 0 && totalSpend > 150) {
          // Pause: zero budget
          suggestedBudget = 0;
          action = "pause";
          reason = `R$${totalSpend.toFixed(2)} investidos sem vendas. Pausar campanha.`;
        } else {
          // Maintain
          suggestedBudget = dailyBudget;
          action = "maintain";
          reason = `Performance moderada. Manter budget atual.`;
        }

        return {
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          current_daily_budget: dailyBudget,
          suggested_daily_budget: suggestedBudget,
          budget_change: parseFloat((suggestedBudget - dailyBudget).toFixed(2)),
          budget_change_pct: dailyBudget > 0 ? parseFloat((((suggestedBudget - dailyBudget) / dailyBudget) * 100).toFixed(1)) : 0,
          avg_cpa: parseFloat(avgCpa.toFixed(2)),
          total_sales_7d: totalSales,
          total_spend_7d: parseFloat(totalSpend.toFixed(2)),
          action,
          reason,
        };
      })
      .filter(Boolean) as NonNullable<ReturnType<typeof Array.prototype.map>[number]>[];

    const totalDailyBudget = recommendations.reduce((s: number, r: any) => s + r.current_daily_budget, 0);
    const suggestedTotalBudget = recommendations.reduce((s: number, r: any) => s + r.suggested_daily_budget, 0);
    const rebalanceDiff = suggestedTotalBudget - totalDailyBudget;

    const increases = recommendations.filter((r: any) => r.action === "increase").length;
    const decreases = recommendations.filter((r: any) => r.action === "decrease").length;
    const pauses = recommendations.filter((r: any) => r.action === "pause").length;
    const maintains = recommendations.filter((r: any) => r.action === "maintain").length;

    res.json({
      totalDailyBudget: parseFloat(totalDailyBudget.toFixed(2)),
      suggestedTotalBudget: parseFloat(suggestedTotalBudget.toFixed(2)),
      rebalance_diff: parseFloat(rebalanceDiff.toFixed(2)),
      recommendations,
      summary: {
        total_campaigns: recommendations.length,
        increase: increases,
        decrease: decreases,
        pause: pauses,
        maintain: maintains,
        message: `${increases} para escalar, ${decreases} para reduzir, ${pauses} para pausar, ${maintains} mantidos.`,
      },
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[metrics] Error computing budget rebalance:", error.message);
    res.json({
      totalDailyBudget: 0,
      suggestedTotalBudget: 0,
      rebalance_diff: 0,
      recommendations: [],
      summary: { total_campaigns: 0, increase: 0, decrease: 0, pause: 0, maintain: 0, message: "Erro ao calcular rebalanceamento." },
    });
  }
});

// ---------------------------------------------------------------------------
// GET /audience-overlap — Audience overlap heuristic (Melhoria 30)
// ---------------------------------------------------------------------------
router.get("/audience-overlap", async (_req: Request, res: Response) => {
  const META_BASE = "https://graph.facebook.com/v19.0";
  const metaToken = process.env.META_ACCESS_TOKEN || "";
  const metaAccountId = process.env.META_AD_ACCOUNT_ID || "";

  try {
    if (!metaToken || !metaAccountId) {
      res.json({ pairs: [], total_waste_estimate: 0, message: "Meta API nao configurada." });
      return;
    }

    // Fetch adset-level insights for last 7 days
    const url = new URL(`${META_BASE}/${metaAccountId}/insights`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "adset_id,adset_name,reach,impressions,spend");
    url.searchParams.set("level", "adset");
    url.searchParams.set("date_preset", "last_7d");

    const response = await fetch(url.toString());
    const data = (await response.json()) as any;

    if (data.error) {
      throw { status: response.status, message: data.error.message };
    }

    const rows: any[] = data.data ?? [];

    if (rows.length < 2) {
      res.json({ pairs: [], total_waste_estimate: 0, message: "Dados insuficientes para analise de sobreposicao." });
      return;
    }

    // Total campaign reach (approximate: sum of unique reaches with overlap)
    const totalCampaignReach = Math.max(...rows.map((r: any) => parseInt(r.reach || "0"))) * 1.5;

    const adsets = rows.map((r: any) => ({
      id: r.adset_id,
      name: r.adset_name || "",
      reach: parseInt(r.reach || "0"),
      impressions: parseInt(r.impressions || "0"),
      spend: parseFloat(r.spend || "0"),
    }));

    const pairs: any[] = [];
    let totalWasteEstimate = 0;

    for (let i = 0; i < adsets.length; i++) {
      for (let j = i + 1; j < adsets.length; j++) {
        const a = adsets[i];
        const b = adsets[j];

        if (a.reach === 0 || b.reach === 0) continue;

        // Heuristic overlap estimation
        const estimatedOverlap = Math.max(0, (a.reach + b.reach - totalCampaignReach)) / Math.min(a.reach, b.reach);
        const overlapPct = Math.min(estimatedOverlap * 100, 100);

        let severity: "high" | "medium" | "low";
        let color: string;
        if (overlapPct > 30) {
          severity = "high";
          color = "#e85040";
        } else if (overlapPct >= 15) {
          severity = "medium";
          color = "#f0c040";
        } else {
          severity = "low";
          color = "#50c878";
        }

        // Only include medium+ overlap
        if (overlapPct >= 15) {
          const wastedSpend = (a.spend + b.spend) * (overlapPct / 100) * 0.5;
          totalWasteEstimate += wastedSpend;

          pairs.push({
            adset_a: { id: a.id, name: a.name, reach: a.reach },
            adset_b: { id: b.id, name: b.name, reach: b.reach },
            overlap_pct: parseFloat(overlapPct.toFixed(1)),
            severity,
            color,
            estimated_wasted_spend: parseFloat(wastedSpend.toFixed(2)),
            source: "heuristic",
            impact: severity === "high"
              ? `Competindo por ${overlapPct.toFixed(0)}% do mesmo público. CPM inflado.`
              : severity === "medium"
              ? `Overlap moderado. Monitorar.`
              : `Overlap baixo. OK.`,
            recommendation: severity === "high"
              ? `Excluir "${a.name}" do público de "${b.name}", ou consolidar em um único ad set.`
              : "Nenhuma ação necessária.",
          });
        }
      }
    }

    // Sort by overlap desc
    pairs.sort((a, b) => b.overlap_pct - a.overlap_pct);

    res.json({
      pairs,
      total_waste_estimate: parseFloat(totalWasteEstimate.toFixed(2)),
      adsets_analyzed: adsets.length,
      message: pairs.length > 0
        ? `${pairs.length} par(es) com sobreposicao significativa detectada.`
        : "Nenhuma sobreposicao significativa detectada.",
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[metrics] Error computing audience overlap:", error.message);
    res.json({ pairs: [], total_waste_estimate: 0, message: "Erro ao analisar sobreposicao de publicos." });
  }
});

// ---------------------------------------------------------------------------
// GET /cpm-trend — CPM trend over time (Ponto 9)
// ---------------------------------------------------------------------------
router.get("/cpm-trend", async (req: Request, res: Response) => {
  try {
    const days = parseInt((req.query.days as string) || "30", 10);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const trends = await prisma.cPMTrend.findMany({
      where: { date: { gte: since } },
      orderBy: { date: "asc" },
    });

    if (trends.length === 0) {
      res.json({ current_cpm: 0, avg_30d_cpm: 0, variation: "0%", is_market_spike: false, trend: [], note: null });
      return;
    }

    const current = trends[trends.length - 1];
    const avg30dCPM = trends.length > 1
      ? trends.slice(0, -1).reduce((sum, t) => sum + t.avgCPM, 0) / (trends.length - 1)
      : current.avgCPM;

    const variation = avg30dCPM > 0 ? ((current.avgCPM - avg30dCPM) / avg30dCPM) * 100 : 0;

    // Check if CTR is stable (market spike)
    const avg30dCTR = trends.length > 1
      ? trends.slice(0, -1).reduce((sum, t) => sum + t.avgCTR, 0) / (trends.length - 1)
      : current.avgCTR;
    const ctrVariation = avg30dCTR > 0 ? Math.abs((current.avgCTR - avg30dCTR) / avg30dCTR) * 100 : 0;
    const isMarketSpike = variation > 20 && ctrVariation < 10;

    res.json({
      current_cpm: current.avgCPM,
      avg_30d_cpm: parseFloat(avg30dCPM.toFixed(2)),
      variation: `${variation > 0 ? "+" : ""}${variation.toFixed(1)}%`,
      is_market_spike: isMarketSpike,
      trend: trends.map((t) => ({
        date: t.date.toISOString().split("T")[0],
        cpm: t.avgCPM,
        ctr: parseFloat((t.avgCTR * 100).toFixed(2)),
        cpa: t.avgCPA,
        spend: t.totalSpend,
      })),
      note: current.note,
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[metrics] Error fetching CPM trend:", error.message);
    res.json({ current_cpm: 0, avg_30d_cpm: 0, variation: "0%", is_market_spike: false, trend: [], note: null });
  }
});

// ---------------------------------------------------------------------------
// GET /ad-diagnostics — Quality/Engagement/Conversion rankings (Ponto 6)
// ---------------------------------------------------------------------------
router.get("/ad-diagnostics", async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || "7d";
    const days = period === "30d" ? 30 : period === "14d" ? 14 : 7;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const diagnostics = await prisma.adDiagnostic.findMany({
      where: { date: { gte: since } },
      orderBy: { date: "desc" },
    });

    // Group by ad (latest entry per ad)
    const byAd = new Map<string, any>();
    for (const d of diagnostics) {
      if (!byAd.has(d.adId)) {
        byAd.set(d.adId, { ...d, totalSpend: 0, entries: 0 });
      }
      const entry = byAd.get(d.adId)!;
      entry.totalSpend += d.spend;
      entry.entries++;
    }

    const isBelowAvg = (r: string) => r.includes("BELOW_AVERAGE");

    function diagnoseAd(quality: string, engagement: string, conversion: string, cpa: number | null): { diagnosis: string; priority: string } {
      const issues: string[] = [];

      if (isBelowAvg(quality)) {
        issues.push("QUALITY BAIXA: LP com experiencia ruim ou clickbait detectado. Revisar LP ou criativo.");
      }
      if (isBelowAvg(engagement)) {
        issues.push("ENGAGEMENT BAIXO: Criativo nao gera interacao. Trocar hook, testar novo angulo ou formato.");
      }
      if (isBelowAvg(conversion)) {
        issues.push("CONVERSAO BAIXA: Publico errado ou oferta fraca. Testar novo publico ou ajustar copy.");
      }

      if (issues.length === 0) {
        if (cpa && cpa > 70) return { diagnosis: "Rankings OK mas CPA alto. Possivel saturacao de frequencia ou aumento de competicao.", priority: "medium" };
        return { diagnosis: "Ad saudavel. Rankings acima da media.", priority: "low" };
      }

      const priority = issues.some(i => i.includes("_10")) ? "critical" : "high";
      return { diagnosis: issues.join(" | "), priority };
    }

    const ads = Array.from(byAd.values()).map((ad) => {
      const { diagnosis, priority } = diagnoseAd(ad.qualityRanking, ad.engagementRanking, ad.conversionRanking, ad.cpa);
      return {
        adId: ad.adId,
        adName: ad.adName,
        adsetId: ad.adsetId,
        campaignId: ad.campaignId,
        quality: ad.qualityRanking,
        engagement: ad.engagementRanking,
        conversion: ad.conversionRanking,
        cpa: ad.cpa ? parseFloat(ad.cpa.toFixed(2)) : null,
        spend_period: parseFloat(ad.totalSpend.toFixed(2)),
        diagnosis,
        priority,
      };
    });

    // Sort by priority
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    ads.sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9));

    const summary = {
      total_ads: ads.length,
      quality_issues: ads.filter(a => isBelowAvg(a.quality)).length,
      engagement_issues: ads.filter(a => isBelowAvg(a.engagement)).length,
      conversion_issues: ads.filter(a => isBelowAvg(a.conversion)).length,
    };

    res.json({ ads, summary, period });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[metrics] Error fetching ad diagnostics:", error.message);
    res.json({ ads: [], summary: { total_ads: 0, quality_issues: 0, engagement_issues: 0, conversion_issues: 0 } });
  }
});

// ---------------------------------------------------------------------------
// GET /funnel — Full funnel analysis (Ponto 5)
// ---------------------------------------------------------------------------
router.get("/funnel", async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || "7d";
    const days = period === "30d" ? 30 : period === "14d" ? 14 : 7;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const metrics = await prisma.metricEntry.aggregate({
      where: { date: { gte: since } },
      _sum: {
        impressions: true,
        clicks: true,
        landingPageViews: true,
        sales: true,
      },
    });

    // Checkouts = cart abandonments + all sales (pending, approved, etc.)
    const cartAbandons = await prisma.cartAbandonment.count({
      where: { createdAt: { gte: since } },
    });
    const allSales = await prisma.sale.count({
      where: { createdAt: { gte: since } },
    });
    const checkouts = cartAbandons + allSales;

    const purchases = await prisma.sale.count({
      where: { createdAt: { gte: since }, status: "approved" },
    });

    const impressions = metrics._sum.impressions || 0;
    const clicks = metrics._sum.clicks || 0;
    const lpViews = metrics._sum.landingPageViews || 0;

    // Rates
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const clickToLp = clicks > 0 ? (lpViews / clicks) * 100 : 0;
    const lpToCheckout = lpViews > 0 ? (checkouts / lpViews) * 100 : 0;
    const checkoutToPurchase = checkouts > 0 ? (purchases / checkouts) * 100 : 0;
    const overallConversion = impressions > 0 ? (purchases / impressions) * 100 : 0;

    // Diagnosis
    const diagnosis: { area: string; status: string; message: string }[] = [];

    if (impressions > 1000 && ctr < 1) {
      diagnosis.push({ area: "creative", status: "critical", message: "CTR abaixo de 1%. Criativos nao estao gerando cliques. Trocar hook ou formato." });
    } else if (ctr >= 1 && ctr < 1.5) {
      diagnosis.push({ area: "creative", status: "warning", message: "CTR entre 1-1.5%. Criativos OK mas podem melhorar." });
    }

    if (clicks > 100 && clickToLp < 70) {
      diagnosis.push({ area: "landing_page", status: "critical", message: `Click→LP em ${clickToLp.toFixed(1)}%. LP pode estar lenta ou URL quebrada. Benchmark: >70%.` });
    }

    if (lpViews > 50 && lpToCheckout < 5) {
      diagnosis.push({ area: "landing_page", status: "warning", message: `LP→Checkout em ${lpToCheckout.toFixed(1)}%. LP nao convence. Revisar headline e oferta. Benchmark: >5%.` });
    }

    if (checkouts > 10 && checkoutToPurchase < 30) {
      diagnosis.push({ area: "checkout", status: "warning", message: `Checkout→Compra em ${checkoutToPurchase.toFixed(1)}%. Atrito no pagamento. Benchmark: >30%.` });
    }

    if (diagnosis.length === 0 && purchases > 0) {
      diagnosis.push({ area: "overall", status: "healthy", message: "Funil saudavel. Todas as taxas dentro dos benchmarks." });
    }

    res.json({
      period,
      funnel: { impressions, clicks, lp_views: lpViews, checkouts, purchases },
      rates: {
        ctr: parseFloat(ctr.toFixed(2)),
        click_to_lp: parseFloat(clickToLp.toFixed(2)),
        lp_to_checkout: parseFloat(lpToCheckout.toFixed(2)),
        checkout_to_purchase: parseFloat(checkoutToPurchase.toFixed(2)),
        overall_conversion: parseFloat(overallConversion.toFixed(4)),
      },
      benchmarks: { ctr: 1.0, click_to_lp: 70, lp_to_checkout: 5, checkout_to_purchase: 30 },
      diagnosis,
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[metrics] Error computing funnel:", error.message);
    res.json({ funnel: {}, rates: {}, diagnosis: [] });
  }
});

export default router;
