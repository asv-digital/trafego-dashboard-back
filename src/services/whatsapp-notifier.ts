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

  test: () =>
    `✅ Teste de conexão — trafego.bravy.com.br\n\n_Notificações WhatsApp funcionando._`,
};

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

  try {
    let response: Response | undefined;

    if (config.whatsappProvider === "z-api") {
      const instanceId = config.whatsappInstanceId || process.env.ZAPI_INSTANCE_ID;
      const token = config.whatsappToken || process.env.ZAPI_TOKEN;

      if (!instanceId || !token) {
        throw new Error("Z-API: instanceId ou token não configurado");
      }

      response = await fetch(
        `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, message }),
        }
      );
    } else if (config.whatsappProvider === "zappfy") {
      // Zappfy — https://docs.zappfy.io
      // POST /send/text?token=TOKEN body { number, text, mentionEveryone }
      const token = config.whatsappToken || process.env.ZAPPFY_TOKEN;
      if (!token) {
        throw new Error("Zappfy: token não configurado");
      }

      response = await fetch(
        `https://api.zappfy.io/send/text?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ number: phone, text: message, mentionEveryone: false }),
        }
      );
    } else if (config.whatsappProvider === "evolution") {
      const instanceId = config.whatsappInstanceId || process.env.EVOLUTION_INSTANCE;
      const token = config.whatsappToken || process.env.EVOLUTION_API_KEY;
      const baseUrl = process.env.EVOLUTION_API_URL || "https://evolution.bravy.com.br";

      if (!instanceId || !token) {
        throw new Error("Evolution: instanceId ou token não configurado");
      }

      response = await fetch(`${baseUrl}/message/sendText/${instanceId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: token,
        },
        body: JSON.stringify({ number: phone, text: message }),
      });
    }

    const success = response?.ok ?? false;

    await prisma.notificationLog.create({
      data: {
        type,
        message,
        channel: "whatsapp",
        status: success ? "sent" : "failed",
        error: success ? null : `HTTP ${response?.status}`,
      },
    });

    if (success) {
      console.log(`[WHATSAPP] ${type} enviado para ${phone}`);
    } else {
      console.error(`[WHATSAPP] Falha ao enviar ${type}: HTTP ${response?.status}`);
    }

    return success;
  } catch (error: any) {
    await prisma.notificationLog.create({
      data: {
        type,
        message,
        channel: "whatsapp",
        status: "failed",
        error: error.message,
      },
    });
    console.error("[WHATSAPP] Erro ao enviar:", error.message);
    return false;
  }
}
