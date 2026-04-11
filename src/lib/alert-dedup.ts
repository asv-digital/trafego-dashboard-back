// Edge-triggered dedup para alertas de estado estacionário.
//
// Regra: só envia o alerta se (a) é a primeira vez pra essa key, (b) o
// estado MUDOU desde a última emissão, ou (c) passou MAX_AGE_MS desde o
// último envio (fallback de segurança — lembra que ainda tá quebrado).
//
// Uso típico: AGENTE SKIPADO e ESTOQUE CRITICO, que disparam a cada ciclo
// enquanto o problema persistir. Sem dedup, cada redeploy ou ciclo de 4h
// re-notifica. Com dedup, 1 alerta por transição de estado + 1 a cada 24h.
//
// NÃO use pra alertas de evento (COLETA META FALHOU, OVER BUDGET, etc) —
// esses devem sempre notificar na primeira ocorrência sem dedup.

import prisma from "../prisma";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function shouldSendStateAlert(
  key: string,
  currentState: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<boolean> {
  const now = new Date();

  try {
    const existing = await prisma.alertDedup.findUnique({ where: { key } });

    if (!existing) {
      await prisma.alertDedup.create({
        data: { key, lastState: currentState, lastSentAt: now },
      });
      return true;
    }

    const stateChanged = existing.lastState !== currentState;
    const stale = now.getTime() - existing.lastSentAt.getTime() >= maxAgeMs;

    if (stateChanged || stale) {
      await prisma.alertDedup.update({
        where: { key },
        data: { lastState: currentState, lastSentAt: now },
      });
      return true;
    }

    return false;
  } catch (err) {
    // Fail loud no stderr, mas não bloqueia o alerta — em caso de erro no
    // dedup, melhor notificar (duplicado) do que engolir um sinal crítico.
    console.error(
      `[AlertDedup] Erro ao checar dedup para "${key}": ${err instanceof Error ? err.message : String(err)}. Enviando alerta por segurança.`,
    );
    return true;
  }
}

// Reset manual — chamado quando sabemos que o estado voltou ao normal e
// queremos garantir que a próxima transição pra "ruim" vai alertar de novo.
// Ex: AccountWatcher detecta active → reset "agent_skipped" dedup.
export async function resetStateAlert(key: string): Promise<void> {
  try {
    await prisma.alertDedup.delete({ where: { key } });
  } catch {
    // Ignora se não existir — é idempotente.
  }
}
