import { runCollection, CollectionSummary } from "./collector";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { updateLearningPhaseStatus } from "../services/learning-phase";
import { executeAutomations } from "../services/auto-executor";
import { sendNotification } from "../services/whatsapp-notifier";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── State ───────────────────────────────────────────────────

let lastRun: string | null = null;
let nextRun: string | null = null;
let isRunning = false;
let lastResult: CollectionSummary | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let dailySummaryTimeout: ReturnType<typeof setTimeout> | null = null;

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
    // 1. Coletar métricas do Meta
    const result = await runCollection();
    lastRun = new Date().toISOString();
    lastResult = result;
    console.log(`[Scheduler] Coleta finalizada em ${lastRun} — ${result.metricsCount} metricas`);

    // 2. Salvar snapshot diário
    try {
      await saveDailySnapshot();
    } catch (snapErr) {
      console.error(`[Scheduler] Erro ao salvar snapshot diário: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
    }

    // 3. Atualizar status de fase de aprendizado (Passo 9)
    try {
      await updateLearningPhaseStatus();
    } catch (err) {
      console.error(`[Scheduler] Erro ao atualizar learning phase: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Executar automações (Passo 6)
    try {
      await executeAutomations();
    } catch (err) {
      console.error(`[Scheduler] Erro ao executar automações: ${err instanceof Error ? err.message : String(err)}`);
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

// ── Daily Summary (8h) ────────────────────────────────────

function scheduleDailySummary(): void {
  const now = new Date();
  const next8am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0, 0);
  if (now >= next8am) {
    next8am.setDate(next8am.getDate() + 1);
  }
  const msUntil8am = next8am.getTime() - now.getTime();

  console.log(`[Scheduler] Resumo diário agendado para ${next8am.toISOString()}`);

  dailySummaryTimeout = setTimeout(async () => {
    await sendDailySummary();
    // Re-schedule for next day
    scheduleDailySummary();
  }, msUntil8am);
}

async function sendDailySummary(): Promise<void> {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    const endOfYesterday = new Date(startOfYesterday.getTime() + 24 * 60 * 60 * 1000);

    const metrics = await prisma.metricEntry.findMany({
      where: { date: { gte: startOfYesterday, lt: endOfYesterday } },
    });

    const totalSpend = metrics.reduce((s, m) => s + m.investment, 0);
    const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
    const cpa = totalSales > 0 ? totalSpend / totalSales : 0;
    const revenue = totalSales * 93.6;
    const roas = totalSpend > 0 ? revenue / totalSpend : 0;

    // Get alerts count
    const campaigns = await prisma.campaign.findMany({
      include: { metrics: { orderBy: { date: "desc" }, take: 1 } },
    });
    let alertCount = 0;
    for (const c of campaigns) {
      const latest = c.metrics[0];
      if (!latest) continue;
      if (latest.investment > 200 && latest.sales === 0) alertCount++;
      const latestCpa = latest.sales > 0 ? latest.investment / latest.sales : 0;
      if (latestCpa > 70) alertCount++;
    }

    await sendNotification("daily_summary", {
      spend: totalSpend.toFixed(0),
      sales: totalSales,
      cpa: cpa.toFixed(2),
      roas: roas.toFixed(2),
      score: lastResult ? Math.round((lastResult.roas / 2) * 100) : "—",
      alerts: alertCount > 0 ? alertCount : null,
    });

    console.log("[Scheduler] Resumo diário enviado via WhatsApp.");
  } catch (err) {
    console.error(`[Scheduler] Erro ao enviar resumo diário: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Daily Snapshot (Melhoria 8) ────────────────────────────

export async function saveDailySnapshot(): Promise<void> {
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDateEnd = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
  const dateLabel = targetDate.toISOString().slice(0, 10);

  const existing = await prisma.dailySnapshot.findUnique({
    where: { date: targetDate },
  });

  if (existing) {
    console.log(`[Snapshot] Snapshot já existe para ${dateLabel}, atualizando...`);
    await prisma.dailySnapshot.delete({ where: { id: existing.id } });
  }

  const entries = await prisma.metricEntry.findMany({
    where: { date: { gte: targetDate, lt: targetDateEnd } },
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

  const ctrValues = entries.filter((e) => e.impressions > 0).map((e) => (e.clicks / e.impressions) * 100);
  const avgCtr = ctrValues.length > 0 ? ctrValues.reduce((a, b) => a + b, 0) / ctrValues.length : 0;

  const cpmValues = entries.filter((e) => e.impressions > 0).map((e) => (e.investment / e.impressions) * 1000);
  const avgCpm = cpmValues.length > 0 ? cpmValues.reduce((a, b) => a + b, 0) / cpmValues.length : 0;

  const freqValues = entries.filter((e) => e.frequency != null).map((e) => e.frequency!);
  const avgFrequency = freqValues.length > 0 ? freqValues.reduce((a, b) => a + b, 0) / freqValues.length : 0;

  const hookValues = entries.filter((e) => e.hookRate != null).map((e) => e.hookRate!);
  const hookRate = hookValues.length > 0 ? hookValues.reduce((a, b) => a + b, 0) / hookValues.length : null;

  const cplpvValues = entries.filter((e) => e.costPerLandingPageView != null).map((e) => e.costPerLandingPageView!);
  const cplpv = cplpvValues.length > 0 ? cplpvValues.reduce((a, b) => a + b, 0) / cplpvValues.length : null;

  const obCtrValues = entries.filter((e) => e.outboundCtr != null).map((e) => e.outboundCtr!);
  const outboundCtr = obCtrValues.length > 0 ? obCtrValues.reduce((a, b) => a + b, 0) / obCtrValues.length : null;

  const breakdownMap: Record<string, any> = {};
  for (const e of entries) {
    if (!breakdownMap[e.campaignId]) {
      breakdownMap[e.campaignId] = {
        campaignName: e.campaign.name,
        spend: 0, sales: 0, revenue: 0, impressions: 0, clicks: 0,
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

  // Schedule daily summary at 8am
  scheduleDailySummary();
}

export async function runNow(): Promise<CollectionSummary> {
  console.log("[Scheduler] Coleta manual disparada.");
  const result = await executeCollection();
  scheduleNext();
  return result;
}

export function getStatus() {
  return { lastRun, nextRun, isRunning, lastResult };
}
