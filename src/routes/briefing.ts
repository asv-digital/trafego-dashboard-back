import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

const PRODUCT_PRICE = 97;
const NET_PER_SALE = 93.6;

// ---------------------------------------------------------------------------
// GET /daily — Daily briefing in natural language (Melhoria 27)
// ---------------------------------------------------------------------------
router.get("/daily", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const dayBefore = new Date(yesterday);
    dayBefore.setDate(dayBefore.getDate() - 1);

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 1. Yesterday's snapshot
    const yesterdaySnap = await prisma.dailySnapshot.findFirst({
      where: { date: { gte: yesterday, lt: new Date(yesterday.getTime() + 86400000) } },
    });

    // 2. Day-before-yesterday snapshot
    const dayBeforeSnap = await prisma.dailySnapshot.findFirst({
      where: { date: { gte: dayBefore, lt: new Date(dayBefore.getTime() + 86400000) } },
    });

    // 3. Last 7 days of snapshots
    const weekSnapshots = await prisma.dailySnapshot.findMany({
      where: { date: { gte: sevenDaysAgo, lte: now } },
      orderBy: { date: "asc" },
    });

    // 4. Scaling rules: last 3 days per campaign
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

    const scalingActions: { name: string; action: string; cpa: number; sales: number }[] = [];
    for (const campaign of campaigns) {
      const metrics = campaign.metrics;
      if (metrics.length === 0) continue;
      const totalSpend = metrics.reduce((s, m) => s + m.investment, 0);
      const totalSales = metrics.reduce((s, m) => s + m.sales, 0);
      const avgCpa = totalSales > 0 ? totalSpend / totalSales : totalSpend > 0 ? 999 : 0;

      let action: string;
      if (avgCpa < 50 && totalSales >= 3) {
        action = "ESCALAR";
      } else if (totalSpend > 200 && totalSales === 0) {
        action = "PAUSAR";
      } else if (avgCpa > 70) {
        action = "PAUSAR";
      } else {
        action = "OBSERVAR";
      }
      scalingActions.push({ name: campaign.name, action, cpa: avgCpa, sales: totalSales });
    }

    // 5. Creative lifecycle
    const creatives = await prisma.creative.findMany();
    const creativeNow = new Date();
    let healthyCount = 0;
    let decliningCount = 0;
    let exhaustedCount = 0;
    let reserveCount = 0;

    for (const c of creatives) {
      const daysActive = Math.floor((creativeNow.getTime() - c.createdAt.getTime()) / 86400000);
      const currentCpa = c.cpa ?? 0;
      const currentCtr = c.ctr ?? 0;
      const degradationFactor = daysActive > 0 ? Math.min(daysActive * 0.015, 0.5) : 0;
      const initialCtr = currentCtr > 0 ? currentCtr / (1 - degradationFactor) : currentCtr;
      const ctrChangePct = initialCtr > 0 ? ((currentCtr - initialCtr) / initialCtr) * 100 : 0;

      if (c.status === "Pausado" && currentCpa > 0 && currentCpa < 60) {
        reserveCount++;
      } else if (currentCpa > 70 || ctrChangePct < -40 || daysActive > 25) {
        exhaustedCount++;
      } else if ((currentCpa > 50 && currentCpa <= 70) || ctrChangePct < -20 || daysActive > 14) {
        decliningCount++;
      } else {
        healthyCount++;
      }
    }

    // 6. Token status
    const metaCreatedAt = process.env.META_TOKEN_CREATED_AT;
    let tokenDaysRemaining = -1;
    if (metaCreatedAt) {
      const expires = new Date(metaCreatedAt);
      expires.setDate(expires.getDate() + 60);
      tokenDaysRemaining = Math.floor((expires.getTime() - Date.now()) / 86400000);
    }

    // Build briefing text
    const lines: string[] = [];
    const dateStr = yesterday.toISOString().split("T")[0];
    let actionsCount = 0;

    // 1. Yesterday summary
    if (yesterdaySnap) {
      const revenue = yesterdaySnap.totalSales * PRODUCT_PRICE;
      lines.push(`Resumo de ${dateStr}:`);
      lines.push(`- Vendas: ${yesterdaySnap.totalSales} | Investimento: R$${yesterdaySnap.totalSpend.toFixed(2)} | Receita bruta: R$${revenue.toFixed(2)}`);
      lines.push(`- CPA: R$${yesterdaySnap.avgCpa.toFixed(2)} | ROAS: ${yesterdaySnap.avgRoas.toFixed(2)}x | CTR: ${yesterdaySnap.avgCtr.toFixed(2)}%`);
    } else {
      lines.push(`Sem dados de snapshot para ${dateStr}.`);
    }

    // 2. Comparison vs day before
    if (yesterdaySnap && dayBeforeSnap) {
      lines.push("");
      lines.push("Comparativo com o dia anterior:");
      const salesDiff = yesterdaySnap.totalSales - dayBeforeSnap.totalSales;
      const spendDiff = yesterdaySnap.totalSpend - dayBeforeSnap.totalSpend;
      const cpaDiff = yesterdaySnap.avgCpa - dayBeforeSnap.avgCpa;
      const roasDiff = yesterdaySnap.avgRoas - dayBeforeSnap.avgRoas;

      const arrow = (v: number, invert = false) => {
        const positive = invert ? v < 0 : v > 0;
        return positive ? "+" : "";
      };

      lines.push(`- Vendas: ${arrow(salesDiff)}${salesDiff} | Investimento: ${arrow(spendDiff)}R$${spendDiff.toFixed(2)}`);
      lines.push(`- CPA: ${arrow(-cpaDiff, true)}R$${cpaDiff.toFixed(2)} | ROAS: ${arrow(roasDiff)}${roasDiff.toFixed(2)}x`);
    }

    // 3. Week trend
    if (weekSnapshots.length >= 3) {
      lines.push("");
      lines.push("Tendencia da semana (ultimos 7 dias):");
      const avgSales = weekSnapshots.reduce((s, snap) => s + snap.totalSales, 0) / weekSnapshots.length;
      const avgSpend = weekSnapshots.reduce((s, snap) => s + snap.totalSpend, 0) / weekSnapshots.length;
      const avgCpa = weekSnapshots.reduce((s, snap) => s + snap.avgCpa, 0) / weekSnapshots.length;
      const avgRoas = weekSnapshots.reduce((s, snap) => s + snap.avgRoas, 0) / weekSnapshots.length;

      lines.push(`- Media diaria: ${avgSales.toFixed(1)} vendas | R$${avgSpend.toFixed(2)} investidos`);
      lines.push(`- CPA medio: R$${avgCpa.toFixed(2)} | ROAS medio: ${avgRoas.toFixed(2)}x`);

      // Trend direction
      const firstHalf = weekSnapshots.slice(0, Math.floor(weekSnapshots.length / 2));
      const secondHalf = weekSnapshots.slice(Math.floor(weekSnapshots.length / 2));
      const firstAvgCpa = firstHalf.reduce((s, snap) => s + snap.avgCpa, 0) / firstHalf.length;
      const secondAvgCpa = secondHalf.reduce((s, snap) => s + snap.avgCpa, 0) / secondHalf.length;

      if (secondAvgCpa < firstAvgCpa * 0.9) {
        lines.push("- Tendencia: CPA melhorando ao longo da semana.");
      } else if (secondAvgCpa > firstAvgCpa * 1.1) {
        lines.push("- Tendencia: CPA piorando. Avaliar otimizacoes.");
      } else {
        lines.push("- Tendencia: CPA estavel na semana.");
      }
    }

    // 4. Campaign actions
    const actionable = scalingActions.filter((a) => a.action !== "OBSERVAR");
    if (actionable.length > 0) {
      lines.push("");
      lines.push("Acoes recomendadas:");
      for (const a of scalingActions) {
        lines.push(`- [${a.action}] ${a.name} — CPA: R$${a.cpa.toFixed(2)}, Vendas (3d): ${a.sales}`);
        if (a.action !== "OBSERVAR") actionsCount++;
      }
    } else if (scalingActions.length > 0) {
      lines.push("");
      lines.push("Campanhas:");
      for (const a of scalingActions) {
        lines.push(`- [${a.action}] ${a.name} — CPA: R$${a.cpa.toFixed(2)}, Vendas (3d): ${a.sales}`);
      }
    }

    // 5. Creative alerts
    if (decliningCount > 0 || exhaustedCount > 0 || reserveCount < 2) {
      lines.push("");
      lines.push("Alertas de criativos:");
      if (exhaustedCount > 0) {
        lines.push(`- ${exhaustedCount} criativo(s) esgotado(s). Substituir urgentemente.`);
        actionsCount++;
      }
      if (decliningCount > 0) {
        lines.push(`- ${decliningCount} criativo(s) em declinio. Preparar substitutos.`);
        actionsCount++;
      }
      lines.push(`- Reserva: ${reserveCount} criativo(s). ${reserveCount < 2 ? "Produzir mais criativos." : "Estoque OK."}`);
    }

    // 6. Token warning
    if (tokenDaysRemaining >= 0 && tokenDaysRemaining < 14) {
      lines.push("");
      lines.push(`AVISO: Token Meta expira em ${tokenDaysRemaining} dia(s). Renovar o quanto antes.`);
      actionsCount++;
    }

    // 7. If nothing urgent
    if (actionsCount === 0) {
      lines.push("");
      lines.push("Nenhuma acao urgente. Operacao rodando bem.");
    }

    const briefing = lines.join("\n");

    let overallStatus: "attention" | "opportunity" | "stable";
    const hasEscalar = scalingActions.some((a) => a.action === "ESCALAR");
    const hasPausar = scalingActions.some((a) => a.action === "PAUSAR");

    if (hasPausar || exhaustedCount > 0 || (tokenDaysRemaining >= 0 && tokenDaysRemaining < 7)) {
      overallStatus = "attention";
    } else if (hasEscalar) {
      overallStatus = "opportunity";
    } else {
      overallStatus = "stable";
    }

    res.json({
      date: dateStr,
      briefing,
      actions_count: actionsCount,
      overall_status: overallStatus,
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[briefing] Error generating daily briefing:", error.message);
    res.json({
      date: new Date().toISOString().split("T")[0],
      briefing: "Erro ao gerar briefing diario.",
      actions_count: 0,
      overall_status: "stable" as const,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /weekly — Weekly briefing comparing current vs previous week (Melhoria 27)
// ---------------------------------------------------------------------------
router.get("/weekly", async (_req: Request, res: Response) => {
  try {
    const now = new Date();

    // Current week: last 7 days
    const currentWeekStart = new Date(now);
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);

    // Previous week: 7-14 days ago
    const previousWeekStart = new Date(now);
    previousWeekStart.setDate(previousWeekStart.getDate() - 14);
    const previousWeekEnd = new Date(currentWeekStart);

    const currentSnapshots = await prisma.dailySnapshot.findMany({
      where: { date: { gte: currentWeekStart, lte: now } },
      orderBy: { date: "asc" },
    });

    const previousSnapshots = await prisma.dailySnapshot.findMany({
      where: { date: { gte: previousWeekStart, lt: previousWeekEnd } },
      orderBy: { date: "asc" },
    });

    const aggregate = (snaps: typeof currentSnapshots) => {
      if (snaps.length === 0) return null;
      const totalSales = snaps.reduce((s, snap) => s + snap.totalSales, 0);
      const totalSpend = snaps.reduce((s, snap) => s + snap.totalSpend, 0);
      const totalRevenue = totalSales * PRODUCT_PRICE;
      const avgCpa = totalSales > 0 ? totalSpend / totalSales : 0;
      const avgRoas = totalSpend > 0 ? (totalSales * NET_PER_SALE) / totalSpend : 0;
      const avgCtr = snaps.reduce((s, snap) => s + snap.avgCtr, 0) / snaps.length;
      return { totalSales, totalSpend, totalRevenue, avgCpa, avgRoas, avgCtr, days: snaps.length };
    };

    const current = aggregate(currentSnapshots);
    const previous = aggregate(previousSnapshots);

    const lines: string[] = [];
    let actionsCount = 0;

    lines.push("Briefing Semanal");
    lines.push("================");

    if (current) {
      lines.push("");
      lines.push("Semana atual (ultimos 7 dias):");
      lines.push(`- Vendas: ${current.totalSales} | Investimento: R$${current.totalSpend.toFixed(2)} | Receita bruta: R$${current.totalRevenue.toFixed(2)}`);
      lines.push(`- CPA medio: R$${current.avgCpa.toFixed(2)} | ROAS: ${current.avgRoas.toFixed(2)}x | CTR: ${current.avgCtr.toFixed(2)}%`);
    } else {
      lines.push("");
      lines.push("Sem dados para a semana atual.");
    }

    if (current && previous) {
      lines.push("");
      lines.push("Comparativo com semana anterior:");

      const pctChange = (curr: number, prev: number) => {
        if (prev === 0) return curr > 0 ? "+100%" : "0%";
        const pct = ((curr - prev) / prev) * 100;
        return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
      };

      lines.push(`- Vendas: ${pctChange(current.totalSales, previous.totalSales)} (${previous.totalSales} -> ${current.totalSales})`);
      lines.push(`- Investimento: ${pctChange(current.totalSpend, previous.totalSpend)}`);
      lines.push(`- CPA: ${pctChange(current.avgCpa, previous.avgCpa)} (R$${previous.avgCpa.toFixed(2)} -> R$${current.avgCpa.toFixed(2)})`);
      lines.push(`- ROAS: ${pctChange(current.avgRoas, previous.avgRoas)} (${previous.avgRoas.toFixed(2)}x -> ${current.avgRoas.toFixed(2)}x)`);

      // Evaluate week performance
      if (current.avgCpa < previous.avgCpa * 0.9 && current.totalSales >= previous.totalSales) {
        lines.push("");
        lines.push("Semana excelente: CPA caiu e vendas se mantiveram ou subiram.");
      } else if (current.avgCpa > previous.avgCpa * 1.15) {
        lines.push("");
        lines.push("Atencao: CPA subiu mais de 15% em relacao a semana passada. Revisar campanhas.");
        actionsCount++;
      } else if (current.totalSales < previous.totalSales * 0.7) {
        lines.push("");
        lines.push("Atencao: Vendas cairam mais de 30% em relacao a semana anterior.");
        actionsCount++;
      }
    } else if (previous) {
      lines.push("");
      lines.push("Semana anterior:");
      lines.push(`- Vendas: ${previous.totalSales} | Investimento: R$${previous.totalSpend.toFixed(2)}`);
    }

    if (actionsCount === 0) {
      lines.push("");
      lines.push("Nenhuma acao urgente. Operacao rodando bem.");
    }

    const briefing = lines.join("\n");

    let overallStatus: "attention" | "opportunity" | "stable";
    if (current && previous) {
      if (current.avgCpa > previous.avgCpa * 1.15 || current.totalSales < previous.totalSales * 0.7) {
        overallStatus = "attention";
      } else if (current.avgCpa < previous.avgCpa * 0.9 && current.totalSales >= previous.totalSales) {
        overallStatus = "opportunity";
      } else {
        overallStatus = "stable";
      }
    } else {
      overallStatus = "stable";
    }

    res.json({
      date: now.toISOString().split("T")[0],
      briefing,
      actions_count: actionsCount,
      overall_status: overallStatus,
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error("[briefing] Error generating weekly briefing:", error.message);
    res.json({
      date: new Date().toISOString().split("T")[0],
      briefing: "Erro ao gerar briefing semanal.",
      actions_count: 0,
      overall_status: "stable" as const,
    });
  }
});

export default router;
