export interface AgentConfig {
  meta: {
    access_token: string;
    ad_account_id: string;
    app_id: string;
    app_secret: string;
  };
  kirvano: {
    api_key: string;
    product_id: string;
  };
  business: {
    product_name: string;
    product_price: number;
    gateway_fee_percent: number;
    net_revenue_per_sale: number;
    daily_budget_target: number;
    cpa_target: number;
    cpa_alert: number;
    roas_target: number;
    roas_alert: number;
  };
}

export interface MetaInsight {
  campaign_name: string;
  campaign_id: string;
  adset_name: string;
  adset_id: string;
  ad_name: string;
  ad_id: string;
  spend: string;
  impressions: string;
  clicks: string;
  cpm: string;
  cpc: string;
  ctr: string;
  frequency: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  outbound_clicks?: any;
  outbound_ctr?: string;
  video_play_actions?: Array<{ action_type: string; value: string }>;
  video_thruplay_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p25_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p50_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p75_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p100_watched_actions?: Array<{ action_type: string; value: string }>;
  date_start: string;
  date_stop: string;
}

export interface MetaPaginatedResponse {
  data: MetaInsight[];
  paging?: {
    cursors?: { before: string; after: string };
    next?: string;
  };
}

export interface KirvanoTransaction {
  id: string;
  status: string;
  amount: number;
  created_at: string;
  product_id: string;
  customer?: {
    email: string;
    name: string;
  };
}

export interface KirvanoResponse {
  data: KirvanoTransaction[];
  meta?: {
    current_page: number;
    last_page: number;
    total: number;
  };
}

export interface ConsolidatedMetric {
  date: string;
  campaignName: string;
  campaignId: string;
  adSetName: string;
  adSetId: string;
  investment: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  sales: number;
  revenue: number;
  cpm: number;
  cpc: number;
  ctr: number;
  cpa: number | null;
  roas: number | null;
  frequency: number;
  hookRate: number | null;
  landingPageViews: number;
  initiateCheckouts: number;
  outboundClicks: number;
  outboundCtr: number | null;
  threeSecondViews: number;
  videoPlays: number;
  costPerLandingPageView: number | null;
}
