import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";
import { NET_PER_SALE } from "../config/constants";
import { acquireLock } from "./automation-coordinator";

const META_BASE = "https://graph.facebook.com/v19.0";

interface VariantMetrics {
  adId: string;
  name: string;
  spend: number;
  sales: number;
  cpa: number;
  roas: number;
}

async function fetchVariantMetrics(adId: string): Promise<VariantMetrics | null> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return null;

  try {
    const url = new URL(`${META_BASE}/${adId}/insights`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "spend,impressions,clicks,actions");
    url.searchParams.set("date_preset", "last_30d");

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      console.error(`[AB-TEST] Erro ao buscar métricas do ad ${adId}: HTTP ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
    const insights = data.data?.[0] ?? {};

    const spend = parseFloat(String(insights.spend ?? "0"));
    const actions = insights.actions as Array<{ action_type: string; value: string }> | undefined;
    const purchaseAction = actions?.find(
      (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const sales = purchaseAction ? parseInt(purchaseAction.value ?? "0") : 0;
    const cpa = sales > 0 ? spend / sales : spend > 0 ? 999 : 0;
    const roas = spend > 0 ? (sales * NET_PER_SALE) / spend : 0;

    return { adId, name: "", spend, sales, cpa, roas };
  } catch (err) {
    console.error(`[AB-TEST] Erro ao buscar métricas do ad ${adId}:`, err);
    return null;
  }
}

async function pauseAd(adId: string): Promise<boolean> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return false;

  try {
    const res = await fetch(`${META_BASE}/${adId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "PAUSED",
        access_token: metaToken,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[AB-TEST] Erro ao pausar ad ${adId}: ${errBody}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[AB-TEST] Erro ao pausar ad ${adId}:`, err);
    return false;
  }
}

export async function resolveActiveTests(): Promise<void> {
  console.log("[AB-TEST] Verificando testes A/B ativos...");

  try {
    const tests = await prisma.creativeTest.findMany({
      where: { status: "running", winner: null },
    });

    if (tests.length === 0) {
      console.log("[AB-TEST] Nenhum teste ativo.");
      return;
    }

    for (const test of tests) {
      const vA = test.variantA as { adId: string; name: string };
      const vB = test.variantB as { adId: string; name: string };

      if (!vA?.adId || !vB?.adId) {
        console.log(`[AB-TEST] Teste ${test.name}: variantes sem adId, pulando.`);
        continue;
      }

      const [metricsA, metricsB] = await Promise.all([
        fetchVariantMetrics(vA.adId),
        fetchVariantMetrics(vB.adId),
      ]);

      if (!metricsA || !metricsB) {
        console.log(`[AB-TEST] Teste ${test.name}: falha ao buscar métricas, pulando.`);
        continue;
      }

      metricsA.name = vA.name;
      metricsB.name = vB.name;

      // Check minimum spend per variant
      if (metricsA.spend < test.minSpendPerVariant || metricsB.spend < test.minSpendPerVariant) {
        console.log(`[AB-TEST] Teste ${test.name}: gasto mínimo não atingido (A: R$${metricsA.spend.toFixed(0)}, B: R$${metricsB.spend.toFixed(0)}, mín: R$${test.minSpendPerVariant}).`);
        continue;
      }

      // Check minimum days
      const daysRunning = Math.floor(
        (Date.now() - test.startDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysRunning < test.minDays) {
        console.log(`[AB-TEST] Teste ${test.name}: ${daysRunning}/${test.minDays} dias, aguardando.`);
        continue;
      }

      // Both need sales to compare CPA meaningfully
      if (metricsA.sales === 0 && metricsB.sales === 0) {
        console.log(`[AB-TEST] Teste ${test.name}: ambas variantes sem vendas, pulando.`);
        continue;
      }

      // Determine winner: CPA > 30% worse than the other
      const cpaDiffThreshold = 0.3;
      let winner: "variantA" | "variantB" | null = null;
      let loser: VariantMetrics | null = null;
      let winnerMetrics: VariantMetrics | null = null;
      let confidence = 0;

      if (metricsA.sales > 0 && metricsB.sales > 0) {
        const cpaDiff = Math.abs(metricsA.cpa - metricsB.cpa) / Math.min(metricsA.cpa, metricsB.cpa);

        if (cpaDiff >= cpaDiffThreshold) {
          if (metricsA.cpa < metricsB.cpa) {
            winner = "variantA";
            winnerMetrics = metricsA;
            loser = metricsB;
          } else {
            winner = "variantB";
            winnerMetrics = metricsB;
            loser = metricsA;
          }
          const totalSales = metricsA.sales + metricsB.sales;
          confidence = Math.min(cpaDiff * 150 + 30, 99);
          if (totalSales < 10) confidence = Math.min(confidence, 85);
          if (totalSales < 4) confidence = Math.min(confidence, 70);
        }
      } else {
        // One has sales, the other doesn't
        if (metricsA.sales > 0 && metricsB.sales === 0 && metricsB.spend >= test.minSpendPerVariant) {
          winner = "variantA";
          winnerMetrics = metricsA;
          loser = metricsB;
          confidence = Math.min(70 + metricsA.sales * 5, 95);
        } else if (metricsB.sales > 0 && metricsA.sales === 0 && metricsA.spend >= test.minSpendPerVariant) {
          winner = "variantB";
          winnerMetrics = metricsB;
          loser = metricsA;
          confidence = Math.min(70 + metricsB.sales * 5, 95);
        }
      }

      if (!winner || !loser || !winnerMetrics) {
        console.log(`[AB-TEST] Teste ${test.name}: diferença de CPA insuficiente (<30%), aguardando.`);
        continue;
      }

      // Declare winner
      await prisma.creativeTest.update({
        where: { id: test.id },
        data: {
          winner,
          confidence: parseFloat(confidence.toFixed(1)),
          decidedAt: new Date(),
          status: "decided",
        },
      });

      // Pause loser ad in Meta
      const pauseSuccess = await pauseAd(loser.adId);

      // Lock de 24h — nenhuma outra automação mexe no loser por 24h
      if (pauseSuccess) {
        await acquireLock('adset', test.adsetId, 'ab_resolver', 'pause', 0, 0);
      }

      const details = `Teste "${test.name}" decidido. Vencedor: ${winnerMetrics.name} (CPA R$${winnerMetrics.cpa.toFixed(2)}). Perdedor: ${loser.name} (CPA R$${loser.cpa.toFixed(2)})${pauseSuccess ? " — pausado" : " — falha ao pausar"}. Confiança: ${confidence.toFixed(0)}%.`;

      await logAction({
        action: "ab_test_decided",
        entityType: "creative_test",
        entityId: test.id,
        entityName: test.name,
        details,
        source: "automation",
      });

      await sendNotification("auto_action", {
        action: "TESTE A/B DECIDIDO",
        adset: test.name,
        reason: `Vencedor: ${winnerMetrics.name} (CPA R$${winnerMetrics.cpa.toFixed(0)}). Perdedor ${loser.name} pausado.`,
      });

      console.log(`[AB-TEST] ${details}`);
    }

    console.log("[AB-TEST] Verificação de testes concluída.");
  } catch (err) {
    console.error("[AB-TEST] Erro ao resolver testes:", err);
  }
}
