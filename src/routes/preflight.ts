import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { getAccountStatus } from "../lib/meta-account";

const router = Router();
const META_BASE = "https://graph.facebook.com/v19.0";

interface Check {
  name: string;
  critical: boolean;
  passed: boolean;
  details: string;
  fix?: string;
}

async function fetchJson(url: string, ms = 8000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

router.get("/", async (_req: Request, res: Response) => {
  const checks: Check[] = [];
  const token = process.env.META_ACCESS_TOKEN || "";
  const account = process.env.META_AD_ACCOUNT_ID || "";
  const pixel = process.env.META_PIXEL_ID || "";
  const page = process.env.META_PAGE_ID || "";
  const kirvanoToken = process.env.KIRVANO_WEBHOOK_TOKEN || "";

  // 1. Env vars básicos
  checks.push({
    name: "env_meta_token",
    critical: true,
    passed: token !== "",
    details: token !== "" ? `Token presente (${token.length} chars)` : "META_ACCESS_TOKEN ausente",
    fix: token === "" ? "Setar META_ACCESS_TOKEN no Coolify" : undefined,
  });

  checks.push({
    name: "env_ad_account",
    critical: true,
    passed: account !== "",
    details: account || "ausente",
    fix: account === "" ? "Setar META_AD_ACCOUNT_ID no Coolify" : undefined,
  });

  checks.push({
    name: "env_pixel",
    critical: true,
    passed: pixel !== "",
    details: pixel || "ausente",
    fix: pixel === "" ? "Setar META_PIXEL_ID no Coolify" : undefined,
  });

  checks.push({
    name: "env_page",
    critical: true,
    passed: page !== "",
    details: page || "ausente",
    fix: page === "" ? "Setar META_PAGE_ID no Coolify" : undefined,
  });

  checks.push({
    name: "env_kirvano_webhook_token",
    critical: true,
    passed: kirvanoToken !== "",
    details: kirvanoToken !== "" ? "configurado" : "ausente",
    fix: kirvanoToken === "" ? "Setar KIRVANO_WEBHOOK_TOKEN no Coolify" : undefined,
  });

  // 2. Database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push({
      name: "database",
      critical: true,
      passed: true,
      details: "Postgres reachable",
    });
  } catch (err) {
    checks.push({
      name: "database",
      critical: true,
      passed: false,
      details: `DB error: ${(err as Error).message}`,
      fix: "Verificar DATABASE_URL e status do Postgres no Coolify",
    });
  }

  // 3. Token expiration
  const tokenCreatedAt = process.env.META_TOKEN_CREATED_AT;
  if (tokenCreatedAt) {
    const expires = new Date(tokenCreatedAt);
    expires.setDate(expires.getDate() + 60);
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86400000);
    checks.push({
      name: "meta_token_expiration",
      critical: daysLeft <= 0,
      passed: daysLeft > 7,
      details: `${daysLeft} dias restantes`,
      fix: daysLeft <= 7 ? "Renovar token Meta antes de expirar" : undefined,
    });
  }

  // 4. Token scopes
  if (token) {
    try {
      const data = await fetchJson(`${META_BASE}/me/permissions?access_token=${encodeURIComponent(token)}`);
      const granted: string[] = (data?.data ?? [])
        .filter((p: any) => p.status === "granted")
        .map((p: any) => p.permission);
      const needed = ["ads_management", "ads_read"];
      const missing = needed.filter(p => !granted.includes(p));
      checks.push({
        name: "meta_token_scopes",
        critical: true,
        passed: missing.length === 0,
        details: `granted: ${granted.join(", ") || "nenhum"}`,
        fix: missing.length > 0 ? `Token sem ${missing.join(", ")} — gerar novo token com esses scopes` : undefined,
      });
    } catch (err) {
      checks.push({
        name: "meta_token_scopes",
        critical: true,
        passed: false,
        details: `Erro ao consultar permissions: ${(err as Error).message}`,
      });
    }
  }

  // 5. Ad account status (canonical)
  if (token && account) {
    const status = await getAccountStatus(true);
    checks.push({
      name: "ad_account_status",
      critical: true,
      passed: status.active,
      details: `${status.status_key}: ${status.message} (${status.name || "?"})`,
      fix: !status.active ? "Resolver billing no Meta Business Settings" : undefined,
    });
  }

  // 6. Page access
  if (token && page) {
    try {
      const data = await fetchJson(`${META_BASE}/${page}?fields=id,name,category&access_token=${encodeURIComponent(token)}`);
      if (data.error) {
        checks.push({
          name: "page_access",
          critical: true,
          passed: false,
          details: `Meta error: ${data.error.message}`,
          fix: "Token sem acesso à Page — verificar sharing no Business Manager",
        });
      } else {
        checks.push({
          name: "page_access",
          critical: true,
          passed: true,
          details: `${data.name} (${data.category || "?"}) id=${data.id}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "page_access",
        critical: true,
        passed: false,
        details: `Erro: ${(err as Error).message}`,
      });
    }
  }

  // 7. Pixel access + last fired
  if (token && pixel) {
    try {
      const data = await fetchJson(`${META_BASE}/${pixel}?fields=id,name,last_fired_time&access_token=${encodeURIComponent(token)}`);
      if (data.error) {
        checks.push({
          name: "pixel_access",
          critical: true,
          passed: false,
          details: `Meta error: ${data.error.message}`,
          fix: "Pixel não compartilhado com ad account — verificar sharing",
        });
      } else {
        const lastFired = data.last_fired_time ? new Date(data.last_fired_time) : null;
        const hoursSinceFired = lastFired ? Math.floor((Date.now() - lastFired.getTime()) / 3600000) : null;
        checks.push({
          name: "pixel_access",
          critical: true,
          passed: true,
          details: `${data.name} id=${data.id}${lastFired ? ` — último evento ${hoursSinceFired}h atrás` : " — nunca disparou"}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "pixel_access",
        critical: true,
        passed: false,
        details: `Erro: ${(err as Error).message}`,
      });
    }
  }

  // 8. Landing page
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch("https://bravy.com.br/skills-claude-code", {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    checks.push({
      name: "landing_page",
      critical: true,
      passed: r.ok,
      details: `HTTP ${r.status} ${r.statusText}`,
      fix: !r.ok ? "Landing page não acessível — verificar deploy" : undefined,
    });
  } catch (err) {
    checks.push({
      name: "landing_page",
      critical: true,
      passed: false,
      details: `Erro: ${(err as Error).message}`,
    });
  }

  // 9. WhatsApp notifier configurado
  try {
    const nc = await prisma.notificationConfig.findFirst({ orderBy: { updatedAt: "desc" } });
    const hasConfig = !!(nc && nc.enabled && nc.whatsappToken && nc.whatsappPhone);
    checks.push({
      name: "whatsapp_notifier",
      critical: false,
      passed: hasConfig,
      details: hasConfig
        ? `${nc!.whatsappProvider} → ${nc!.whatsappPhone}`
        : "não configurado",
      fix: !hasConfig ? "Configurar via PUT /api/notifications/config" : undefined,
    });
  } catch (err) {
    checks.push({
      name: "whatsapp_notifier",
      critical: false,
      passed: false,
      details: `Erro: ${(err as Error).message}`,
    });
  }

  // 10. Custom audience de COMPRADORES — exclusão crítica em Prospecção LAL.
  //     Regra Pedro Sobral: NUNCA mostrar anúncio de prospecção pra quem já
  //     comprou. Sem essa audience, LAL queima budget em buyers.
  const buyersAudienceId = process.env.META_BUYERS_AUDIENCE_ID || process.env.META_AUDIENCE_BUYERS_ID || "";
  if (buyersAudienceId && token) {
    try {
      const data = await fetchJson(`${META_BASE}/${buyersAudienceId}?fields=id,name,approximate_count_lower_bound,subtype&access_token=${encodeURIComponent(token)}`);
      if (data.error) {
        checks.push({
          name: "buyers_audience",
          critical: true,
          passed: false,
          details: `Audience ID configurado mas Meta retornou: ${data.error.message}`,
          fix: "Verificar se audience existe e token tem permissão",
        });
      } else {
        checks.push({
          name: "buyers_audience",
          critical: true,
          passed: true,
          details: `${data.name} id=${data.id}${data.approximate_count_lower_bound != null ? ` (~${data.approximate_count_lower_bound} pessoas)` : ""}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "buyers_audience",
        critical: true,
        passed: false,
        details: `Erro: ${(err as Error).message}`,
      });
    }
  } else {
    checks.push({
      name: "buyers_audience",
      critical: true,
      passed: false,
      details: "META_BUYERS_AUDIENCE_ID não configurado",
      fix: "Criar Custom Audience 'Compradores' no Meta Events Manager (Pixel Purchase, 180 dias) e setar env var",
    });
  }

  // 11. Custom audience de ABANDONADORES — usada pelo template REMARKETING.
  //     Sem isso, REMARKETING falha na criação (backend exige o audience ID).
  const abandonersAudienceId = process.env.META_AUDIENCE_ABANDONERS_ID || "";
  if (abandonersAudienceId && token) {
    try {
      const data = await fetchJson(`${META_BASE}/${abandonersAudienceId}?fields=id,name,approximate_count_lower_bound,subtype&access_token=${encodeURIComponent(token)}`);
      if (data.error) {
        checks.push({
          name: "abandoners_audience",
          critical: true,
          passed: false,
          details: `Audience ID configurado mas Meta retornou: ${data.error.message}`,
          fix: "Verificar se audience existe e token tem permissão",
        });
      } else {
        checks.push({
          name: "abandoners_audience",
          critical: true,
          passed: true,
          details: `${data.name} id=${data.id}${data.approximate_count_lower_bound != null ? ` (~${data.approximate_count_lower_bound} pessoas)` : ""}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "abandoners_audience",
        critical: true,
        passed: false,
        details: `Erro: ${(err as Error).message}`,
      });
    }
  } else {
    checks.push({
      name: "abandoners_audience",
      critical: true,
      passed: false,
      details: "META_AUDIENCE_ABANDONERS_ID não configurado",
      fix: "Criar Custom Audience 'Abandonadores' (InitiateCheckout/ViewContent 7d) e setar env var",
    });
  }

  // 12. Campaign Builder templates carregam
  try {
    const tpl = await import("../config/campaign-templates");
    const keys = Object.keys(tpl.CAMPAIGN_TEMPLATES ?? {});
    checks.push({
      name: "campaign_builder_templates",
      critical: true,
      passed: keys.length > 0,
      details: `${keys.length} templates: ${keys.join(", ")}`,
    });
  } catch (err) {
    checks.push({
      name: "campaign_builder_templates",
      critical: true,
      passed: false,
      details: `Erro: ${(err as Error).message}`,
    });
  }

  // Resumo
  const criticalFailures = checks.filter(c => c.critical && !c.passed);
  const warnings = checks.filter(c => !c.critical && !c.passed);

  res.json({
    all_ready: criticalFailures.length === 0,
    critical_failures: criticalFailures.length,
    warnings: warnings.length,
    checks,
    blockers: criticalFailures.map(c => `${c.name}: ${c.details}${c.fix ? ` → ${c.fix}` : ""}`),
    checked_at: new Date().toISOString(),
  });
});

export default router;
