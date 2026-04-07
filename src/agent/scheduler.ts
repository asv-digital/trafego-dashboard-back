import { runCollection, CollectionSummary } from "./collector";

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
