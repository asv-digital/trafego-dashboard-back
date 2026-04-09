import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "../routes/actions";

export async function updateLearningPhaseStatus(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { isInLearningPhase: true },
  });

  for (const campaign of campaigns) {
    if (campaign.learningPhaseEnd && new Date() > campaign.learningPhaseEnd) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { isInLearningPhase: false },
      });

      console.log(`[LEARNING] ${campaign.name} saiu da fase de aprendizado.`);

      await sendNotification("learning_phase_exit", {
        campaign_name: campaign.name,
      });

      await logAction({
        action: "learning_phase_complete",
        entityType: "campaign",
        entityId: campaign.id,
        entityName: campaign.name,
        details: "Fase de aprendizado concluída após 72h. Métricas agora confiáveis. Ações automáticas reativadas.",
        source: "system",
      });
    }
  }
}
