import prisma from "../prisma";
import { logAction } from "../routes/actions";
import { sendNotification } from "./whatsapp-notifier";

const META_BASE = "https://graph.facebook.com/v19.0";

// ── 1. Coletar comentários dos ads via Meta API ─────────────

async function getActiveAds(): Promise<Array<{ id: string; name: string }>> {
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !metaAccountId) return [];

  try {
    const url = new URL(`${META_BASE}/${metaAccountId}/ads`);
    url.searchParams.set("access_token", metaToken);
    url.searchParams.set("fields", "id,name");
    url.searchParams.set("filtering", JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
    url.searchParams.set("limit", "100");

    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    return (json.data ?? []).map((a: any) => ({ id: a.id, name: a.name || "" }));
  } catch {
    return [];
  }
}

export async function collectAdComments(): Promise<void> {
  console.log("[COMMENTS] Coletando comentarios dos ads...");
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!metaToken) return;

  const activeAds = await getActiveAds();
  let totalNew = 0;

  for (const ad of activeAds) {
    try {
      const url = new URL(`${META_BASE}/${ad.id}/comments`);
      url.searchParams.set("access_token", metaToken);
      url.searchParams.set("fields", "id,message,from,created_time");
      url.searchParams.set("limit", "50");
      url.searchParams.set("order", "reverse_chronological");

      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const json = (await res.json()) as any;
      const comments: any[] = json.data ?? [];

      for (const comment of comments) {
        if (!comment.message) continue;
        const exists = await prisma.adComment.findUnique({ where: { commentId: comment.id } });
        if (exists) continue;

        await prisma.adComment.create({
          data: {
            adId: ad.id,
            adName: ad.name,
            commentId: comment.id,
            message: comment.message,
            authorName: comment.from?.name || null,
            createdAt: new Date(comment.created_time),
          },
        });
        totalNew++;
      }
    } catch (e) {
      console.error(`[COMMENTS] Erro ao coletar do ad ${ad.id}:`, e);
    }
  }

  console.log(`[COMMENTS] ${totalNew} novos comentarios coletados.`);
}

// ── 2. Analisar comentários via LLM ─────────────────────────

export async function analyzeComments(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[COMMENTS] ANTHROPIC_API_KEY nao configurada, pulando analise.");
    return;
  }

  const unanalyzed = await prisma.adComment.findMany({
    where: { sentiment: null },
    take: 100,
  });

  if (unanalyzed.length === 0) return;
  console.log(`[COMMENTS] Analisando ${unanalyzed.length} comentarios...`);

  // Agrupar por ad
  const byAd = new Map<string, typeof unanalyzed>();
  for (const comment of unanalyzed) {
    if (!byAd.has(comment.adId)) byAd.set(comment.adId, []);
    byAd.get(comment.adId)!.push(comment);
  }

  for (const [adId, comments] of byAd) {
    const commentTexts = comments.map((c, i) => `[${i + 1}] ${c.message}`).join("\n");

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: `Classifique cada comentario de um anuncio do produto "56 Skills de Claude Code" (R$97) com UMA das categorias:
- positive: elogio, interesse genuino, "quero comprar"
- negative: critica, reclamacao, insatisfacao
- objection_price: acha caro, questiona preco
- objection_trust: desconfia se funciona, "e golpe?"
- question: duvida sobre o produto
- tag_friend: marca alguem (@fulano, "olha isso")
- neutral: irrelevante, emoji solto

Comentarios:
${commentTexts}

Responda APENAS em JSON array:
[{"index": 1, "sentiment": "positive"}, ...]`,
          }],
        }),
      });

      if (!res.ok) {
        console.error(`[COMMENTS] LLM error: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as any;
      const text = data.content?.[0]?.text || "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const classifications = JSON.parse(jsonMatch[0]) as Array<{ index: number; sentiment: string }>;

      for (const cls of classifications) {
        const comment = comments[cls.index - 1];
        if (comment && cls.sentiment) {
          await prisma.adComment.update({
            where: { id: comment.id },
            data: { sentiment: cls.sentiment, analyzedAt: new Date() },
          });
        }
      }
    } catch (e) {
      console.error(`[COMMENTS] Erro ao analisar ad ${adId}:`, e);
    }
  }

  console.log("[COMMENTS] Analise concluida.");
}

// ── 3. Gerar resumos por ad ─────────────────────────────────

export async function generateCommentSummaries(): Promise<void> {
  console.log("[COMMENTS] Gerando resumos...");
  const ads = await getActiveAds();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  for (const ad of ads) {
    const comments7d = await prisma.adComment.findMany({
      where: { adId: ad.id, sentiment: { not: null }, createdAt: { gte: sevenDaysAgo } },
    });

    if (comments7d.length < 3) continue;

    const counts = {
      positive: comments7d.filter((c) => c.sentiment === "positive").length,
      negative: comments7d.filter((c) => c.sentiment === "negative").length,
      objectionPrice: comments7d.filter((c) => c.sentiment === "objection_price").length,
      objectionTrust: comments7d.filter((c) => c.sentiment === "objection_trust").length,
      questions: comments7d.filter((c) => c.sentiment === "question").length,
      tagFriend: comments7d.filter((c) => c.sentiment === "tag_friend").length,
      neutral: comments7d.filter((c) => c.sentiment === "neutral").length,
    };

    let topObjection: string | null = null;
    let recommendation: string | null = null;

    if (counts.objectionPrice > counts.objectionTrust && counts.objectionPrice >= 3) {
      topObjection = "Preco";
      recommendation = "Muitos comentarios sobre preco. Criar criativo focado em ROI/valor ou adicionar bonus.";
    } else if (counts.objectionTrust >= 3) {
      topObjection = "Confianca";
      recommendation = "Muitas duvidas sobre legitimidade. Criar criativo de prova social (depoimentos, numero de alunos).";
    } else if (counts.tagFriend >= 5) {
      recommendation = `Ad viral: ${counts.tagFriend} marcacoes de amigos em 7 dias. ESCALAR ESTE AD imediatamente.`;
    } else if (counts.questions >= 3) {
      topObjection = "Duvidas";
      recommendation = "Muitas perguntas. Criar criativo FAQ ou atualizar LP com secao de FAQ.";
    }

    await prisma.adCommentSummary.upsert({
      where: { adId_period: { adId: ad.id, period: "7d" } },
      create: { adId: ad.id, adName: ad.name, period: "7d", totalComments: comments7d.length, ...counts, topObjection, recommendation },
      update: { adName: ad.name, totalComments: comments7d.length, ...counts, topObjection, recommendation, analyzedAt: new Date() },
    });

    // Notificar se viral
    if (counts.tagFriend >= 5) {
      await sendNotification("auto_action", {
        action: "AD VIRAL DETECTADO",
        adset: ad.name,
        reason: `${counts.tagFriend} marcacoes de amigos em 7 dias. Escalar este ad!`,
      });
    }
  }

  console.log("[COMMENTS] Resumos gerados.");
}
