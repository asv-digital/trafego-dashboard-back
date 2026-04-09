import prisma from "../prisma";

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

export interface CreativeStockResult {
  healthy_count: number;
  declining_count: number;
  exhausted_count: number;
  alert_level: "ok" | "warning" | "critical";
  days_until_crisis: number;
  top_angle: string | null;
  recommendation: string;
}

export async function checkCreativeStock(): Promise<CreativeStockResult> {
  const creatives = await prisma.creative.findMany({ where: { status: "Ativo" } });

  const healthy = creatives.filter((c) => {
    const daysActive = daysSince(c.createdAt);
    return daysActive < 14 && (c.cpa || 0) < 70;
  });

  const declining = creatives.filter((c) => {
    const daysActive = daysSince(c.createdAt);
    return (daysActive >= 14 && daysActive < 25) || ((c.cpa || 0) >= 50 && (c.cpa || 0) < 70);
  });

  const exhausted = creatives.filter((c) => {
    const daysActive = daysSince(c.createdAt);
    return daysActive >= 25 || (c.cpa || 0) >= 70;
  });

  // Estimar dias até crise
  const avgDaysRemaining =
    healthy.length > 0
      ? healthy.reduce((sum, c) => sum + Math.max(0, 25 - daysSince(c.createdAt)), 0) / healthy.length
      : 0;

  // Identificar melhor ângulo pelo hook rate
  const angles = ["custo_equipe", "prova_social", "curiosidade", "antes_depois", "polemica", "autoridade", "urgencia"];
  let topAngle: string | null = null;
  let bestHookRate = 0;

  for (const angle of angles) {
    const terms = angle.replace("_", " ").split(" ");
    const angleCreatives = creatives.filter((c) => {
      const name = (c.name || "").toLowerCase();
      return terms.some((t) => name.includes(t));
    });
    if (angleCreatives.length > 0) {
      const avgHook = angleCreatives.reduce((sum, c) => sum + (c.hookRate || 0), 0) / angleCreatives.length;
      if (avgHook > bestHookRate) {
        bestHookRate = avgHook;
        topAngle = angle;
      }
    }
  }

  let alertLevel: "ok" | "warning" | "critical" = "ok";
  let recommendation = "";

  if (healthy.length < 2) {
    alertLevel = "critical";
    recommendation = `URGENTE: Apenas ${healthy.length} criativo(s) saudavel(is). Produza 3-5 novos ESTA SEMANA.`;
  } else if (healthy.length < 4) {
    alertLevel = "warning";
    recommendation = `Estoque baixo: ${healthy.length} criativos saudaveis. Produza 2-3 novos nos proximos 5 dias.`;
  } else {
    recommendation = `Estoque OK: ${healthy.length} criativos saudaveis. Proxima producao em ~${Math.round(avgDaysRemaining)} dias.`;
  }

  if (topAngle) {
    recommendation += ` Melhor angulo: "${topAngle.replace("_", " ")}" (hook rate medio: ${(bestHookRate * 100).toFixed(1)}%).`;
  }

  return {
    healthy_count: healthy.length,
    declining_count: declining.length,
    exhausted_count: exhausted.length,
    alert_level: alertLevel,
    days_until_crisis: Math.round(avgDaysRemaining),
    top_angle: topAngle,
    recommendation,
  };
}
