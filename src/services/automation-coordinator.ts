import prisma from "../prisma";

const LOCK_DURATIONS: Record<string, number> = {
  auto_executor: 4 * 60,     // 4 horas (até a próxima execução)
  budget_rebalancer: 4 * 60, // 4 horas
  dayparting: 65,             // 65 minutos (pouco mais que o intervalo de 1h)
  ab_resolver: 24 * 60,      // 24 horas (decisão de teste é definitiva)
};

// Hierarquia de prioridade (maior número = maior prioridade)
const PRIORITY: Record<string, number> = {
  ab_resolver: 4,
  auto_executor: 3,
  budget_rebalancer: 2,
  dayparting: 1,
};

export async function canAutomate(
  entityType: string,
  entityId: string,
  requestedBy: string
): Promise<{ allowed: boolean; blockedBy?: string; reason?: string }> {
  const existingLock = await prisma.automationLock.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
  });

  if (!existingLock) return { allowed: true };

  // Lock expirado → limpar e permitir
  if (new Date() > existingLock.expiresAt) {
    await prisma.automationLock.delete({ where: { id: existingLock.id } });
    return { allowed: true };
  }

  // Mesmo serviço pode sobrescrever seu próprio lock
  if (existingLock.lockedBy === requestedBy) return { allowed: true };

  const requestPriority = PRIORITY[requestedBy] ?? 0;
  const lockPriority = PRIORITY[existingLock.lockedBy] ?? 0;

  if (requestPriority > lockPriority) {
    // Maior prioridade pode sobrescrever
    await prisma.automationLock.delete({ where: { id: existingLock.id } });
    return { allowed: true };
  }

  return {
    allowed: false,
    blockedBy: existingLock.lockedBy,
    reason: `Bloqueado por ${existingLock.lockedBy} (ação: ${existingLock.action}) até ${existingLock.expiresAt.toISOString()}`,
  };
}

export async function acquireLock(
  entityType: string,
  entityId: string,
  lockedBy: string,
  action: string,
  previousValue?: number,
  newValue?: number
): Promise<void> {
  const durationMinutes = LOCK_DURATIONS[lockedBy] ?? 60;
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

  await prisma.automationLock.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    create: { entityType, entityId, lockedBy, action, previousValue, newValue, expiresAt },
    update: { lockedBy, action, previousValue, newValue, expiresAt },
  });
}

export async function cleanExpiredLocks(): Promise<number> {
  const result = await prisma.automationLock.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
