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

export const CAMPAIGN_TEMPLATES: Record<string, CampaignTemplate> = {
  PROSPECCAO_BROAD: {
    key: "PROSPECCAO_BROAD",
    label: "Prospeccao Broad",
    description: "Publico aberto 25-55, sem interesse. Broad targeting.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: { ...baseTargeting },
    dailyBudget: 5000,
    suggestedBudgetReais: 50,
  },
  PROSPECCAO_LAL: {
    key: "PROSPECCAO_LAL",
    label: "Prospeccao Lookalike",
    description: "Lookalike de compradores. Exclui compradores.",
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
  REMARKETING: {
    key: "REMARKETING",
    label: "Remarketing",
    description: "Cart abandoners. Exclui compradores.",
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
    dailyBudget: 3000,
    suggestedBudgetReais: 30,
  },
  ASC: {
    key: "ASC",
    label: "Advantage Shopping (ASC)",
    description: "Meta gerencia targeting e otimizacao automaticamente.",
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
    description: "2 ad sets identicos com criativos diferentes para comparar.",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    targeting: { ...baseTargeting },
    dailyBudget: 3000,
    suggestedBudgetReais: 30,
  },
};
