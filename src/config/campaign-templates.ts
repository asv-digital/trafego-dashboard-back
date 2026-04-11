export interface CampaignTemplate {
  key: string;
  label: string;
  description: string;
  objective: string;
  buyingType: string;
  bidStrategy: string;
  optimizationGoal: string;
  billingEvent: string;
  targeting: Record<string, any>;
  dailyBudget: number; // centavos Meta
  suggestedBudgetReais: number;
}

const baseTargeting = {
  geo_locations: { countries: ["BR"] },
  age_min: 25,
  age_max: 55,
  publisher_platforms: ["facebook", "instagram"],
  facebook_positions: ["feed", "video_feeds", "story", "reels"],
  instagram_positions: ["stream", "story", "reels", "explore"],
};

// Budgets dimensionados pra operação R$500/dia (metodologia Pedro Sobral):
// - Prospecção LAL: R$200/dia — motor principal, maior budget pra sair de learning
//   phase rápido (Meta precisa ~50 conversões/semana).
// - Prospecção Broad: R$150/dia — reserva de escala, pra quando LAL saturar.
// - ASC: R$100/dia — Meta gerencia, ótimo complemento pós-validação.
// - Remarketing: R$50/dia — só roda quando houver audience abandoners > 1000.
// - Teste A/B: R$100/dia total (R$50 por variante) — budget de validação.
//
// Total máximo simultâneo respeita cap R$500/dia do budget-guard.
export const CAMPAIGN_TEMPLATES: Record<string, CampaignTemplate> = {
  PROSPECCAO_BROAD: {
    key: "PROSPECCAO_BROAD",
    label: "Prospeccao Broad",
    description: "Publico aberto 25-55, sem interesse. Broad targeting. Reserva de escala.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: { ...baseTargeting },
    dailyBudget: 15000,
    suggestedBudgetReais: 150,
  },
  PROSPECCAO_LAL: {
    key: "PROSPECCAO_LAL",
    label: "Prospeccao Lookalike",
    description: "Lookalike de compradores. Exclui compradores. Motor principal.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: {
      ...baseTargeting,
      custom_audiences: [], // preenchido no launch
      excluded_custom_audiences: [], // preenchido no launch
    },
    dailyBudget: 20000,
    suggestedBudgetReais: 200,
  },
  REMARKETING: {
    key: "REMARKETING",
    label: "Remarketing",
    description: "Cart abandoners. Exclui compradores. Ativar apenas com audience > 1000.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: {
      ...baseTargeting,
      custom_audiences: [], // preenchido no launch
      excluded_custom_audiences: [], // preenchido no launch
    },
    dailyBudget: 5000,
    suggestedBudgetReais: 50,
  },
  ASC: {
    key: "ASC",
    label: "Advantage Shopping (ASC)",
    description: "Meta gerencia targeting e otimizacao. Complemento ao LAL.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: {},
    dailyBudget: 10000,
    suggestedBudgetReais: 100,
  },
  TESTE_AB: {
    key: "TESTE_AB",
    label: "Teste A/B",
    description: "2 ad sets identicos com criativos diferentes. R$50 por variante.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: { ...baseTargeting },
    dailyBudget: 5000,
    suggestedBudgetReais: 50,
  },
};
