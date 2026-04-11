import prisma from "../prisma";

const NOTIFICATION_TEMPLATES: Record<string, (data: any) => string> = {
  auto_action: (data) =>
    `🤖 *Ação Automática*\n\n` +
    `Ação: ${data.action}\n` +
    `Ad Set: ${data.adset}\n` +
    `Motivo: ${data.reason}\n\n` +
    `_Executado automaticamente pelo agente._`,

  creative_distributed: (data) =>
    `🎨 *Criativo Distribuído*\n\n` +
    `${data.action}\n\n` +
    `_Upload processado automaticamente._`,

  learning_phase_exit: (data) =>
    `✅ *Fase de Aprendizado Concluída*\n\n` +
    `Campanha: ${data.campaign_name}\n` +
    `Status: Métricas agora confiáveis.\n` +
    `Ação: Botões de escala/pausa reativados.\n\n` +
    `_O agente já está monitorando._`,

  alert_critical: (data) =>
    `🚨 *ALERTA CRÍTICO*\n\n` +
    `Tipo: ${data.type}\n` +
    `Detalhe: ${data.detail}\n` +
    `Ação: ${data.action}\n\n` +
    `_Acesse trafego.bravy.com.br agora._`,

  daily_summary: (data) =>
    `📊 *Resumo Diário — Bravy School*\n\n` +
    `Investido: R$${data.spend}\n` +
    `Vendas: ${data.sales}\n` +
    `CPA: R$${data.cpa}\n` +
    `ROAS: ${data.roas}x\n` +
    `Score: ${data.score}/100\n\n` +
    `${data.alerts ? `${data.alerts} alerta(s) pendente(s).\n` : ""}` +
    `_Acesse trafego.bravy.com.br para detalhes._`,

  auto_pause_breakeven: (data) =>
    `🛑 *Auto-Pause: CPA Acima do Breakeven*\n\n` +
    `Ad Set: ${data.adset}\n` +
    `CPA médio (${data.days}d): R$${data.avg_cpa}\n` +
    `Breakeven: R$${data.breakeven}\n` +
    `Prejuízo estimado: R$${data.loss}\n\n` +
    `_Pausado automaticamente. Ad set estava dando prejuízo._`,

  account_restored: (data) =>
    `🟢 *CONTA META LIBERADA*\n\n` +
    `Conta: ${data.name}\n` +
    `Status anterior: ${data.previous_status}\n` +
    `Status atual: ativa\n\n` +
    `✅ Pedro Sobral já pode lançar. launch_ready=true.\n\n` +
    `_Acesse trafego.bravy.com.br → aba Lancar._`,

  account_blocked: (data) =>
    `🔴 *CONTA META BLOQUEADA*\n\n` +
    `Conta: ${data.name}\n` +
    `Status: ${data.status_key}\n` +
    `Motivo: ${data.message}\n\n` +
    `⛔ Launches e automações suspensas até resolver.\n\n` +
    `_Resolva no Meta Business Settings._`,

  test: () =>
    `✅ Teste de conexão — trafego.bravy.com.br\n\n_Notificações WhatsApp funcionando._`,
};

// Backoff em ms entre tentativas. 3 tentativas totais: imediato, +2s, +10s.
// Resolve falhas transitórias (timeout de rede, 502/503 do provider, rate limit
// momentâneo) sem precisar esperar o próximo ciclo de 4h pra tentar de novo.
const RETRY_DELAYS_MS = [0, 2000, 10000];

type ProviderConfig = {
  provider: string;
  whatsappInstanceId?: string | null;
  whatsappToken?: string | null;
};

// Envia uma única tentativa via provider configurado. Lança em qualquer falha
// (HTTP !ok, erro de rede, config faltando) pra que o loop de retry capture.
async function sendViaProvider(
  config: ProviderConfig,
  phone: string,
  message: string,
): Promise<void> {
  let response: Response | undefined;

  if (config.provider === "z-api") {
    const instanceId = config.whatsappInstanceId || process.env.ZAPI_INSTANCE_ID;
    const token = config.whatsappToken || process.env.ZAPI_TOKEN;
    if (!instanceId || !token) throw new Error("Z-API: instanceId ou token não configurado");

    response = await fetch(
      `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, message }),
      },
    );
  } else if (config.provider === "zappfy") {
    const token = config.whatsappToken || process.env.ZAPPFY_TOKEN;
    if (!token) throw new Error("Zappfy: token não configurado");

    response = await fetch(
      `https://api.zappfy.io/send/text?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: phone, text: message, mentionEveryone: false }),
      },
    );
  } else if (config.provider === "evolution") {
    const instanceId = config.whatsappInstanceId || process.env.EVOLUTION_INSTANCE;
    const token = config.whatsappToken || process.env.EVOLUTION_API_KEY;
    const baseUrl = process.env.EVOLUTION_API_URL || "https://evolution.bravy.com.br";
    if (!instanceId || !token) throw new Error("Evolution: instanceId ou token não configurado");

    response = await fetch(`${baseUrl}/message/sendText/${instanceId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: token },
      body: JSON.stringify({ number: phone, text: message }),
    });
  } else {
    throw new Error(`Provider desconhecido: ${config.provider}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendNotification(type: string, data: any = {}): Promise<boolean> {
  const config = await prisma.notificationConfig.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (!config || !config.enabled) return false;

  // Verificar se este tipo de notificação está habilitado
  if ((type === "auto_action" || type === "auto_pause_breakeven") && !config.notifyAutoActions) return false;
  if (type === "creative_distributed" && !config.notifyCreativeActions) return false;
  if (type === "learning_phase_exit" && !config.notifyLearningPhase) return false;
  if (type === "alert_critical" && !config.notifyAlerts) return false;
  if ((type === "account_blocked" || type === "account_restored") && !config.notifyAlerts) return false;
  if (type === "daily_summary" && !config.notifyDailySummary) return false;

  const template = NOTIFICATION_TEMPLATES[type];
  if (!template) {
    console.error(`[WHATSAPP] Template não encontrado para tipo: ${type}`);
    return false;
  }

  const message = template(data);
  const phone = config.whatsappPhone || process.env.WHATSAPP_OPERATOR_PHONE;

  if (!phone) {
    console.error("[WHATSAPP] Nenhum telefone configurado.");
    return false;
  }

  const providerConfig: ProviderConfig = {
    provider: config.whatsappProvider ?? "",
    whatsappInstanceId: config.whatsappInstanceId,
    whatsappToken: config.whatsappToken,
  };

  // Retry loop: 3 tentativas com backoff. Só persiste 1 linha em NotificationLog
  // por chamada — com info de quantas tentativas foram feitas.
  const errors: string[] = [];
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) await sleep(RETRY_DELAYS_MS[attempt]);

    try {
      await sendViaProvider(providerConfig, phone, message);

      await prisma.notificationLog.create({
        data: {
          type,
          message,
          channel: "whatsapp",
          status: "sent",
          error: attempt > 0 ? `ok após ${attempt + 1}ª tentativa` : null,
        },
      });
      console.log(
        `[WHATSAPP] ${type} enviado para ${phone}${attempt > 0 ? ` (após ${attempt + 1} tentativas)` : ""}`,
      );
      return true;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      errors.push(`tentativa ${attempt + 1}: ${msg}`);
      console.error(`[WHATSAPP] Tentativa ${attempt + 1}/${RETRY_DELAYS_MS.length} falhou para ${type}: ${msg}`);
    }
  }

  // Todas as tentativas falharam. Loud fail: log + NotificationLog.failed.
  // A visibilidade do problema vem via /api/notifications/health + badge do frontend.
  await prisma.notificationLog.create({
    data: {
      type,
      message,
      channel: "whatsapp",
      status: "failed",
      error: errors.join(" | "),
    },
  });
  console.error(`[WHATSAPP] FALHA DEFINITIVA ao enviar ${type} após ${RETRY_DELAYS_MS.length} tentativas`);
  return false;
}
