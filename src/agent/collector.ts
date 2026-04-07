import "dotenv/config";
import fs from "fs";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import type { AgentConfig, MetaInsight, ConsolidatedMetric } from "./types";
import { MetaClient, getActionValue, getLandingPageViews, getInitiateCheckouts, getOutboundClicks, getVideoPlays, getThreeSecondViews } from "./meta-client";
import { KirvanoClient } from "./kirvano-client";

// ── Load config (env vars first, fallback to file) ───────────

function loadConfig(): AgentConfig {
  // Try environment variables first (production)
  if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
    return {
      meta: {
        access_token: process.env.META_ACCESS_TOKEN,
        ad_account_id: process.env.META_AD_ACCOUNT_ID,
        app_id: process.env.META_APP_ID || "",
        app_secret: process.env.META_APP_SECRET || "",
      },
      kirvano: {
        api_key: process.env.KIRVANO_API_KEY || "",
        product_id: process.env.KIRVANO_PRODUCT_ID || "",
      },
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
    };
  }

  // Fallback to config file (local development)
  const configPath = path.resolve(__dirname, "../../agent-config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // Return empty config if no file found
    return {
      meta: { access_token: "", ad_account_id: "", app_id: "", app_secret: "" },
      kirvano: { api_key: "", product_id: "" },
      business: {
        product_name: "56 Skills de Claude Code",
        product_price: 97,
        gateway_fee_percent: 3.5,
        net_revenue_per_sale: 93.6,
        daily_budget_target: 500,
        cpa_target: 50,
        cpa_alert: 70,
        roas_target: 2.0,
        roas_alert: 1.4,
      },
    };
  }
}

const config: AgentConfig = loadConfig();

// ── Prisma setup ─────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Helpers ──────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function isConfigured(): boolean {
  return (
    config.meta.access_token !== "COLE_SEU_TOKEN_AQUI" &&
    config.meta.ad_account_id !== "act_XXXXXXXXXX"
  );
}

// ── Consolidate Meta insights into per-campaign-per-date metrics ──

function consolidateInsights(
  insights: MetaInsight[],
  kirvanoCounts: Map<string, number>,
  biz: AgentConfig["business"]
): ConsolidatedMetric[] {
  // Group by campaign + adset + date
  const grouped = new Map<string, MetaInsight[]>();

  for (const row of insights) {
    const key = `${row.campaign_id}|${row.adset_id}|${row.date_start}`;
    const arr = grouped.get(key) ?? [];
    arr.push(row);
    grouped.set(key, arr);
  }

  const metrics: ConsolidatedMetric[] = [];

  for (const [, rows] of grouped) {
    const first = rows[0];
    const date = first.date_start;

    // Sum across ads in the same adset+campaign+date
    let investment = 0;
    let impressions = 0;
    let clicks = 0;
    let linkClicks = 0;
    let metaPurchases = 0;
    let frequency = 0;
    let videoViews3s = 0;
    let videoImpressions = 0;
    let landingPageViews = 0;
    let initiateCheckouts = 0;
    let outboundClicks = 0;
    let threeSecondViews = 0;
    let videoPlays = 0;

    for (const row of rows) {
      investment += parseFloat(row.spend) || 0;
      impressions += parseInt(row.impressions) || 0;
      clicks += parseInt(row.clicks) || 0;
      linkClicks += getActionValue(row.actions, "link_click");
      metaPurchases += getActionValue(row.actions, "purchase");
      frequency = Math.max(frequency, parseFloat(row.frequency) || 0);
      landingPageViews += getLandingPageViews(row.actions);
      initiateCheckouts += getInitiateCheckouts(row.actions);
      outboundClicks += getOutboundClicks(row);
      videoPlays += getVideoPlays(row);
      threeSecondViews += getThreeSecondViews(row);

      const v25 = getActionValue(row.video_p25_watched_actions, "video_view");
      if (v25 > 0) {
        videoViews3s += v25;
        videoImpressions += parseInt(row.impressions) || 0;
      }
    }

    // Prefer Kirvano sales (real revenue source), fallback to Meta pixel
    const kirvanSales = kirvanoCounts.get(date) ?? 0;
    const sales = kirvanSales > 0 ? kirvanSales : metaPurchases;

    const revenue = sales * biz.net_revenue_per_sale;
    const hookRate = impressions > 0 && threeSecondViews > 0 ? (threeSecondViews / impressions) * 100 : (videoImpressions > 0 ? (videoViews3s / videoImpressions) * 100 : null);
    const outboundCtr = impressions > 0 && outboundClicks > 0 ? (outboundClicks / impressions) * 100 : null;
    const costPerLpv = landingPageViews > 0 ? investment / landingPageViews : null;

    metrics.push({
      date,
      campaignName: first.campaign_name,
      campaignId: first.campaign_id,
      adSetName: first.adset_name,
      adSetId: first.adset_id,
      investment,
      impressions,
      clicks: linkClicks > 0 ? linkClicks : clicks,
      linkClicks,
      sales,
      revenue,
      cpm: impressions > 0 ? (investment / impressions) * 1000 : 0,
      cpc: clicks > 0 ? investment / clicks : 0,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cpa: sales > 0 ? investment / sales : null,
      roas: investment > 0 ? revenue / investment : null,
      frequency,
      hookRate,
      landingPageViews,
      initiateCheckouts,
      outboundClicks,
      outboundCtr,
      threeSecondViews,
      videoPlays,
      costPerLandingPageView: costPerLpv,
    });
  }

  return metrics.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Sync to database ─────────────────────────────────────────

async function syncToDatabase(metrics: ConsolidatedMetric[]): Promise<void> {
  // Group by campaign
  const byCampaign = new Map<string, ConsolidatedMetric[]>();
  for (const m of metrics) {
    const arr = byCampaign.get(m.campaignName) ?? [];
    arr.push(m);
    byCampaign.set(m.campaignName, arr);
  }

  for (const [name, campaignMetrics] of byCampaign) {
    // Upsert campaign
    let campaign = await prisma.campaign.findFirst({ where: { name } });

    if (!campaign) {
      campaign = await prisma.campaign.create({
        data: {
          name,
          type: name.toLowerCase().includes("remarketing") ? "Remarketing" : "Prospecção",
          dailyBudget: config.business.daily_budget_target / 2,
          startDate: new Date(campaignMetrics[0].date),
          status: "Ativa",
        },
      });
      console.log(`  [+] Campanha criada: ${name}`);
    }

    // Insert metrics (skip duplicates by date + campaign)
    for (const m of campaignMetrics) {
      const existing = await prisma.metricEntry.findFirst({
        where: {
          campaignId: campaign.id,
          date: new Date(m.date),
          adSet: m.adSetName,
        },
      });

      if (existing) {
        console.log(`  [=] Métrica já existe: ${name} @ ${m.date} — pulando`);
        continue;
      }

      await prisma.metricEntry.create({
        data: {
          date: new Date(m.date),
          campaignId: campaign.id,
          adSet: m.adSetName,
          investment: m.investment,
          impressions: m.impressions,
          clicks: m.clicks,
          sales: m.sales,
          frequency: m.frequency,
          hookRate: m.hookRate,
          landingPageViews: m.landingPageViews || null,
          initiateCheckouts: m.initiateCheckouts || null,
          outboundClicks: m.outboundClicks || null,
          outboundCtr: m.outboundCtr,
          threeSecondViews: m.threeSecondViews || null,
          videoPlays: m.videoPlays || null,
          costPerLandingPageView: m.costPerLandingPageView,
          clickToPageViewRate: m.landingPageViews > 0 && m.clicks > 0 ? (m.landingPageViews / m.clicks) * 100 : null,
          pageViewToCheckout: m.initiateCheckouts > 0 && m.landingPageViews > 0 ? (m.initiateCheckouts / m.landingPageViews) * 100 : null,
          checkoutToSaleRate: m.sales > 0 && m.initiateCheckouts > 0 ? (m.sales / m.initiateCheckouts) * 100 : null,
          observations: `[Auto] Meta ID: ${m.campaignId} | AdSet: ${m.adSetId}`,
        },
      });
      console.log(`  [+] Métrica salva: ${name} @ ${m.date} — R$${m.investment.toFixed(2)} | ${m.sales} vendas`);
    }
  }
}

// ── Collection summary type ─────────────────────────────────

export interface CollectionSummary {
  totalInvestment: number;
  totalSales: number;
  totalRevenue: number;
  cpa: number;
  roas: number;
  metricsCount: number;
  alerts: string[];
}

// ── Exported collection function (used by scheduler + API) ──

export async function runCollection(): Promise<CollectionSummary> {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Bravy School — Agente Coletor de Tráfego");
  console.log("═══════════════════════════════════════════════════\n");

  if (!isConfigured()) {
    console.log("Agente nao configurado. Edite agent-config.json.");
    return {
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: ["Agente nao configurado. Edite agent-config.json com suas credenciais."],
    };
  }

  const dateFrom = daysAgo(7);
  const dateTo = today();
  console.log(`Periodo: ${dateFrom} -> ${dateTo}\n`);

  // 1. Fetch Meta Ads data
  console.log("[1/4] Buscando dados do Meta Ads...");
  const meta = new MetaClient(config.meta);
  const insights = await meta.getInsights(dateFrom, dateTo);
  console.log(`      ${insights.length} registros de insights encontrados.\n`);

  // 2. Fetch Kirvano sales (via API, if configured — otherwise sales come via webhook)
  let salesByDate = new Map<string, number>();
  let totalSales = 0;

  const kirvanoConfigured =
    config.kirvano.api_key !== "COLE_SUA_API_KEY_AQUI" && config.kirvano.api_key !== "";

  if (kirvanoConfigured) {
    console.log("[2/4] Buscando vendas da Kirvano...");
    try {
      const kirvano = new KirvanoClient(config.kirvano);
      const transactions = await kirvano.getTransactions(dateFrom, dateTo);
      salesByDate = KirvanoClient.groupByDate(transactions);
      totalSales = [...salesByDate.values()].reduce((a, b) => a + b, 0);
      console.log(`      ${transactions.length} transacoes | ${totalSales} vendas aprovadas.\n`);
    } catch (err) {
      console.log(`      Kirvano API indisponivel. Vendas virao via webhook.\n`);
    }
  } else {
    console.log("[2/4] Kirvano nao configurada (vendas chegam via webhook).\n");
  }

  // 3. Consolidate
  console.log("[3/4] Consolidando metricas...");
  const consolidated = consolidateInsights(insights, salesByDate, config.business);
  console.log(`      ${consolidated.length} registros consolidados.\n`);

  // 4. Sync to database
  console.log("[4/4] Salvando no banco de dados...");
  await syncToDatabase(consolidated);

  // Summary
  const totalInvestment = consolidated.reduce((s, m) => s + m.investment, 0);
  const totalRevenue = consolidated.reduce((s, m) => s + m.revenue, 0);
  const overallCpa = totalSales > 0 ? totalInvestment / totalSales : 0;
  const overallRoas = totalInvestment > 0 ? totalRevenue / totalInvestment : 0;

  console.log("\n===================================================");
  console.log("  RESUMO DO PERIODO");
  console.log("===================================================");
  console.log(`  Investimento: R$ ${totalInvestment.toFixed(2)}`);
  console.log(`  Vendas:       ${totalSales}`);
  console.log(`  Receita:      R$ ${totalRevenue.toFixed(2)}`);
  console.log(`  CPA:          R$ ${overallCpa.toFixed(2)}`);
  console.log(`  ROAS:         ${overallRoas.toFixed(2)}x`);
  console.log("===================================================\n");

  // Diagnostics
  const alerts: string[] = [];
  if (overallCpa > config.business.cpa_alert) {
    alerts.push("CPA acima do limite! Revise criativos e publicos.");
    console.log("ALERTA: CPA acima do limite! Revise criativos e publicos.");
  } else if (overallCpa > config.business.cpa_target) {
    alerts.push("CPA na zona de alerta. Monitore de perto.");
    console.log("ATENCAO: CPA na zona de alerta. Monitore de perto.");
  } else if (totalSales > 0) {
    console.log("CPA saudavel. Considere escalar 20-30%.");
  }

  console.log("\nAgente finalizado com sucesso.");

  return {
    totalInvestment,
    totalSales,
    totalRevenue,
    cpa: overallCpa,
    roas: overallRoas,
    metricsCount: consolidated.length,
    alerts,
  };
}

// ── Standalone run (npm run agent) ──────────────────────────

async function run() {
  try {
    await runCollection();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Only run standalone when this file is executed directly (not imported)
const isDirectRun =
  require.main === module || process.argv[1]?.endsWith("collector.ts") || process.argv[1]?.endsWith("collector.js");

if (isDirectRun) {
  run().catch(async (err) => {
    console.error("Erro no agente:", err);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
}
