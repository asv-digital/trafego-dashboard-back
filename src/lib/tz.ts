// BRT timezone helpers. Brazil aboliu DST em 2019 — offset fixo UTC-3.
// NÃO confiar em Date.getHours() / setHours() (local do servidor).
// Sempre usar estas funções quando comparar ou agendar em hora brasileira.

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

/** Hora atual em BRT, 0-23. */
export function currentHourBRT(): number {
  const now = new Date();
  return (now.getUTCHours() + 24 - 3) % 24;
}

/**
 * Retorna um Date (em tempo real UTC) que corresponde ao próximo
 * horário hourBRT:00 no fuso São Paulo. Se já passou hoje, avança 1 dia.
 */
export function nextHourBRT(hourBRT: number): Date {
  const now = new Date();
  // Trabalhar em "BRT-encoded" Date: now_brt tem os getUTC* retornando valores BRT.
  const nowBrt = new Date(now.getTime() + BRT_OFFSET_MS);
  const targetBrt = new Date(nowBrt);
  targetBrt.setUTCHours(hourBRT, 0, 0, 0);
  if (targetBrt.getTime() <= nowBrt.getTime()) {
    targetBrt.setUTCDate(targetBrt.getUTCDate() + 1);
  }
  return new Date(targetBrt.getTime() - BRT_OFFSET_MS);
}

/** YYYY-MM-DD no fuso BRT a partir de um Date UTC. */
export function dateStringBRT(d: Date = new Date()): string {
  const brt = new Date(d.getTime() + BRT_OFFSET_MS);
  return brt.toISOString().slice(0, 10);
}

/** Hora do dia (0-23) no fuso BRT a partir de um Date UTC. */
export function hourBRTFromDate(d: Date): number {
  const brt = new Date(d.getTime() + BRT_OFFSET_MS);
  return brt.getUTCHours();
}
