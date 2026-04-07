import "dotenv/config";
import fs from "fs";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import type { AgentConfig, MetaInsight, ConsolidatedMetric } from "./types";
import { MetaClient, getActionValue } from "./meta-client";
import { KirvanoClient } from "./kirvano-client";

// ── Load config ──────────────────────────────────────────────

const configPath = path.resolve(__dirname, "../../agent-config.json");
const config: AgentConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

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

    for (const row of rows) {
      investment += parseFloat(row.spend) || 0;
      impressions += parseInt(row.impressions) || 0;
      clicks += parseInt(row.clicks) || 0;
      linkClicks += getActionValue(row.actions, "link_click");
      metaPurchases += getActionValue(row.actions, "purchase");
      frequency = Math.max(frequency, parseFloat(row.frequency) || 0);

      // Hook rate approximation: video views at 25% / impressions for that ad
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
    const hookRate = videoImpressions > 0 ? (videoViews3s / videoImpressions) * 100 : null;

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
          observations: `[Auto] Meta ID: ${m.campaignId} | AdSet: ${m.adSetId}`,
        },
      });
      console.log(`  [+] Métrica salva: ${name} @ ${m.date} — R$${m.investment.toFixed(2)} | ${m.sales} vendas`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Bravy School — Agente Coletor de Tráfego");
  console.log("═══════════════════════════════════════════════════\n");

  if (!isConfigured()) {
    console.log("⚠  Agente não configurado.");
    console.log("   Edite o arquivo agent-config.json com suas credenciais:");
    console.log("   - Meta Ads: access_token + ad_account_id");
    console.log("   - Kirvano: api_key + product_id\n");
    console.log("   Após configurar, rode: npm run agent\n");
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  const dateFrom = daysAgo(7);
  const dateTo = today();
  console.log(`Período: ${dateFrom} → ${dateTo}\n`);

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
      console.log(`      ${transactions.length} transações | ${totalSales} vendas aprovadas.\n`);
    } catch (err) {
      console.log(`      ⚠ Kirvano API indisponível. Vendas virão via webhook.\n`);
    }
  } else {
    console.log("[2/4] Kirvano não configurada (vendas chegam via webhook).\n");
  }

  // 3. Consolidate
  console.log("[3/4] Consolidando métricas...");
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

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  RESUMO DO PERÍODO");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Investimento: R$ ${totalInvestment.toFixed(2)}`);
  console.log(`  Vendas:       ${totalSales}`);
  console.log(`  Receita:      R$ ${totalRevenue.toFixed(2)}`);
  console.log(`  CPA:          R$ ${overallCpa.toFixed(2)}`);
  console.log(`  ROAS:         ${overallRoas.toFixed(2)}x`);
  console.log("═══════════════════════════════════════════════════\n");

  // Diagnostics
  if (overallCpa > config.business.cpa_alert) {
    console.log("🔴 ALERTA: CPA acima do limite! Revise criativos e públicos.");
  } else if (overallCpa > config.business.cpa_target) {
    console.log("🟡 ATENÇÃO: CPA na zona de alerta. Monitore de perto.");
  } else if (totalSales > 0) {
    console.log("🟢 CPA saudável. Considere escalar 20-30%.");
  }

  await prisma.$disconnect();
  await pool.end();
  console.log("\nAgente finalizado com sucesso.");
}

run().catch(async (err) => {
  console.error("Erro no agente:", err);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
});
