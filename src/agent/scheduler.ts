import { runCollection, CollectionSummary } from "./collector";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── State ───────────────────────────────────────────────────

let lastRun: string | null = null;
let nextRun: string | null = null;
let isRunning = false;
let lastResult: CollectionSummary | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

// ── Internal runner ─────────────────────────────────────────

async function executeCollection(): Promise<CollectionSummary> {
  if (isRunning) {
    console.log("[Scheduler] Coleta ja em andamento, ignorando...");
    return lastResult ?? {
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: ["Coleta ja em andamento."],
    };
  }

  isRunning = true;
  const startedAt = new Date().toISOString();
  console.log(`[Scheduler] Iniciando coleta em ${startedAt}`);

  try {
    const result = await runCollection();
    lastRun = new Date().toISOString();
    lastResult = result;
    console.log(`[Scheduler] Coleta finalizada em ${lastRun} — ${result.metricsCount} metricas`);

    // Save/update daily snapshot after each collection cycle
    try {
      await saveDailySnapshot();
    } catch (snapErr) {
      console.error(`[Scheduler] Erro ao salvar snapshot diário: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
    }

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] Erro na coleta: ${errorMsg}`);
    lastRun = new Date().toISOString();
    lastResult = {
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: [`Erro na coleta: ${errorMsg}`],
    };
    return lastResult;
  } finally {
    isRunning = false;
  }
}

function scheduleNext(): void {
  nextRun = new Date(Date.now() + FOUR_HOURS_MS).toISOString();
}

// ── Daily Snapshot (Melhoria 8) ────────────────────────────

export async function saveDailySnapshot(): Promise<void> {
  // Use today's date (start of day in local timezone)
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDateEnd = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
  const dateLabel = targetDate.toISOString().slice(0, 10);

  // Check if snapshot already exists for this date
  const existing = await prisma.dailySnapshot.findUnique({
    where: { date: targetDate },
  });

  if (existing) {
    console.log(`[Snapshot] Snapshot já existe para ${dateLabel}, atualizando...`);
    // Delete existing to replace with fresh data
    await prisma.dailySnapshot.delete({ where: { id: existing.id } });
  }

  // Aggregate all MetricEntry records for the target date
  const entries = await prisma.metricEntry.findMany({
    where: {
      date: { gte: targetDate, lt: targetDateEnd },
    },
    include: { campaign: true },
  });

  if (entries.length === 0) {
    console.log(`[Snapshot] Nenhuma métrica encontrada para ${dateLabel}, ignorando.`);
    return;
  }

  const totalSpend = entries.reduce((sum, e) => sum + e.investment, 0);
  const totalSales = entries.reduce((sum, e) => sum + e.sales, 0);
  const totalRevenue = totalSales * 93.6;
  const avgCpa = totalSales > 0 ? totalSpend / totalSales : 0;
  const avgRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  // CTR: clicks/impressions*100 per entry, then average
  const ctrValues = entries
    .filter((e) => e.impressions > 0)
    .map((e) => (e.clicks / e.impressions) * 100);
  const avgCtr = ctrValues.length > 0
    ? ctrValues.reduce((a, b) => a + b, 0) / ctrValues.length
    : 0;

  // CPM: investment/impressions*1000 per entry, then average
  const cpmValues = entries
    .filter((e) => e.impressions > 0)
    .map((e) => (e.investment / e.impressions) * 1000);
  const avgCpm = cpmValues.length > 0
    ? cpmValues.reduce((a, b) => a + b, 0) / cpmValues.length
    : 0;

  // Frequency: average where not null
  const freqValues = entries.filter((e) => e.frequency != null).map((e) => e.frequency!);
  const avgFrequency = freqValues.length > 0
    ? freqValues.reduce((a, b) => a + b, 0) / freqValues.length
    : 0;

  // HookRate: average where not null
  const hookValues = entries.filter((e) => e.hookRate != null).map((e) => e.hookRate!);
  const hookRate = hookValues.length > 0
    ? hookValues.reduce((a, b) => a + b, 0) / hookValues.length
    : null;

  // CPLPV: average where not null
  const cplpvValues = entries.filter((e) => e.costPerLandingPageView != null).map((e) => e.costPerLandingPageView!);
  const cplpv = cplpvValues.length > 0
    ? cplpvValues.reduce((a, b) => a + b, 0) / cplpvValues.length
    : null;

  // Outbound CTR: average where not null
  const obCtrValues = entries.filter((e) => e.outboundCtr != null).map((e) => e.outboundCtr!);
  const outboundCtr = obCtrValues.length > 0
    ? obCtrValues.reduce((a, b) => a + b, 0) / obCtrValues.length
    : null;

  // Campaign breakdown: per-campaign totals
  const breakdownMap: Record<string, {
    campaignName: string;
    spend: number;
    sales: number;
    revenue: number;
    impressions: number;
    clicks: number;
  }> = {};

  for (const e of entries) {
    if (!breakdownMap[e.campaignId]) {
      breakdownMap[e.campaignId] = {
        campaignName: e.campaign.name,
        spend: 0,
        sales: 0,
        revenue: 0,
        impressions: 0,
        clicks: 0,
      };
    }
    const b = breakdownMap[e.campaignId];
    b.spend += e.investment;
    b.sales += e.sales;
    b.revenue += e.sales * 93.6;
    b.impressions += e.impressions;
    b.clicks += e.clicks;
  }

  await prisma.dailySnapshot.create({
    data: {
      date: targetDate,
      totalSpend: parseFloat(totalSpend.toFixed(2)),
      totalSales,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      avgCpa: parseFloat(avgCpa.toFixed(2)),
      avgRoas: parseFloat(avgRoas.toFixed(2)),
      avgCtr: parseFloat(avgCtr.toFixed(2)),
      avgCpm: parseFloat(avgCpm.toFixed(2)),
      avgFrequency: parseFloat(avgFrequency.toFixed(2)),
      hookRate: hookRate != null ? parseFloat(hookRate.toFixed(2)) : null,
      cplpv: cplpv != null ? parseFloat(cplpv.toFixed(2)) : null,
      outboundCtr: outboundCtr != null ? parseFloat(outboundCtr.toFixed(2)) : null,
      campaignBreakdown: breakdownMap,
      source: "agent",
    },
  });

  console.log(`[Snapshot] Snapshot diário salvo: ${dateLabel}`);
}

// ── Exported functions ──────────────────────────────────────

/** Start the scheduler — call once from server boot. */
export function startScheduler(): void {
  console.log("[Scheduler] Agendando coleta a cada 4 horas.");
  console.log(`[Scheduler] Primeira coleta em ${STARTUP_DELAY_MS / 1000}s...`);

  // Run once after startup delay
  setTimeout(async () => {
    await executeCollection();
    scheduleNext();
  }, STARTUP_DELAY_MS);

  // Then repeat every 4 hours
  intervalHandle = setInterval(async () => {
    await executeCollection();
    scheduleNext();
  }, FOUR_HOURS_MS);

  // Set initial nextRun to the startup delay
  nextRun = new Date(Date.now() + STARTUP_DELAY_MS).toISOString();
}

/** Trigger an immediate collection run (from API endpoint). */
export async function runNow(): Promise<CollectionSummary> {
  console.log("[Scheduler] Coleta manual disparada.");
  const result = await executeCollection();
  scheduleNext();
  return result;
}

/** Get current scheduler status. */
export function getStatus() {
  return {
    lastRun,
    nextRun,
    isRunning,
    lastResult,
  };
}
