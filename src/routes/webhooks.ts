import { Router, Request, Response } from "express";
import crypto from "crypto";
import prisma from "../prisma";

const router = Router();

const WEBHOOK_TOKEN = process.env.KIRVANO_WEBHOOK_TOKEN || "";
const PRODUCT_ID = process.env.KIRVANO_PRODUCT_ID || "";
const META_PIXEL_ID = process.env.META_PIXEL_ID || "";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";

import { PRODUCT_PRICE, KIRVANO_FEE_RATE, NET_PER_SALE } from "../config/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizeEvent(raw: string | undefined): string {
  if (!raw) return "unknown";
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function extractCustomer(payload: any) {
  const c = payload.customer || payload.comprador || payload.buyer || {};
  const fullName = c.name || c.nome || payload.customer_name || "";
  const parts = fullName.split(" ");
  const firstName = parts[0] || "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return {
    email: c.email || payload.customer_email || undefined,
    phone: c.phone || c.telefone || c.phone_number || payload.customer_phone || undefined,
    name: fullName || undefined,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
  };
}

function extractUtm(payload: any) {
  const utm = payload.utm || payload.tracking || {};
  return {
    utmSource: payload.utm_source || utm.utm_source || utm.source || undefined,
    utmMedium: payload.utm_medium || utm.utm_medium || utm.medium || undefined,
    utmCampaign: payload.utm_campaign || utm.utm_campaign || utm.campaign || undefined,
    utmContent: payload.utm_content || utm.utm_content || utm.content || undefined,
    utmTerm: payload.utm_term || utm.utm_term || utm.term || undefined,
  };
}

function extractTxId(payload: any): string | null {
  // Nunca gerar UUID random — quebra idempotência e permite duplicar vendas.
  // Se Kirvano não mandar nenhum ID, rejeitamos o webhook.
  return (
    payload.transaction_id ||
    payload.sale_id ||
    payload.kirvano_tx_id ||
    payload.id ||
    null
  );
}

function extractCheckoutId(payload: any): string | undefined {
  return payload.checkout_id || payload.kirvano_checkout_id || undefined;
}

function extractAmount(payload: any): number {
  const raw =
    payload.amount ??
    payload.valor ??
    payload.sale?.amount ??
    payload.purchase?.amount ??
    payload.value;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? PRODUCT_PRICE : parsed;
}

function extractPaymentMethod(payload: any): string {
  return (
    payload.payment_method ||
    payload.payment?.method ||
    payload.forma_pagamento ||
    "unknown"
  );
}

function extractMetaIds(payload: any) {
  const utm = payload.utm || payload.tracking || {};
  return {
    metaCampaignId: payload.meta_campaign_id || utm.meta_campaign_id || undefined,
    metaAdsetId: payload.meta_adset_id || utm.meta_adset_id || undefined,
    metaAdId: payload.meta_ad_id || utm.meta_ad_id || undefined,
  };
}

// ---------------------------------------------------------------------------
// CAPI — Conversions API (Melhoria 1)
// ---------------------------------------------------------------------------

async function sendCapiPurchaseEvent(sale: {
  id: string;
  kirvanoTxId: string;
  amountGross: number;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
}): Promise<boolean> {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    console.log("CAPI: skipped — META_PIXEL_ID or META_ACCESS_TOKEN not set");
    return false;
  }

  try {
    const userData: Record<string, string[]> = {};
    const matchKeys: string[] = [];

    if (sale.customerEmail) {
      userData.em = [sha256(sale.customerEmail)];
      matchKeys.push("email");
    }
    if (sale.customerPhone) {
      userData.ph = [sha256(sale.customerPhone)];
      matchKeys.push("phone");
    }
    if (sale.customerFirstName) {
      userData.fn = [sha256(sale.customerFirstName)];
    }
    if (sale.customerLastName) {
      userData.ln = [sha256(sale.customerLastName)];
    }

    // Deduplication (CAPI + Pixel):
    // Usa sale.id como event_id. O pixel do browser deve enviar o mesmo ID:
    //   fbq('track', 'Purchase', { value: amount, currency: 'BRL' }, { eventID: saleId });
    // Quando ambos enviam o mesmo event_id, o Meta deduplica automaticamente.
    // Ref: https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
    const eventId = sale.id;

    const body = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: "website",
          user_data: userData,
          custom_data: {
            currency: "BRL",
            value: sale.amountGross,
          },
        },
      ],
      access_token: META_ACCESS_TOKEN,
    };

    const url = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("CAPI: Meta API error", result);
      return false;
    }

    console.log(
      `CAPI: Purchase enviado para Meta | event_id: ${eventId} | match_keys: ${matchKeys.join(",")}`
    );
    return true;
  } catch (err) {
    console.error("CAPI: failed to send event", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Custom Audience — add buyer after purchase (Melhoria 16)
// ---------------------------------------------------------------------------

async function addBuyerToCustomAudience(email: string, phone?: string) {
  const audienceId = process.env.META_BUYERS_AUDIENCE_ID;
  if (!audienceId || !META_ACCESS_TOKEN) return;

  try {
    const schema = phone ? ["EMAIL", "PHONE"] : ["EMAIL"];
    const data = phone
      ? [[sha256(email), sha256(phone)]]
      : [[sha256(email)]];

    await fetch(`https://graph.facebook.com/v19.0/${audienceId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: { schema, data },
        access_token: META_ACCESS_TOKEN,
      }),
    });
    console.log(`[Webhook] Comprador adicionado ao Custom Audience`);
  } catch (err) {
    console.error("[Webhook] Erro ao adicionar ao Custom Audience:", err);
  }
}

// ---------------------------------------------------------------------------
// CAPI — Generic event sender (Ponto 4: InitiateCheckout)
// ---------------------------------------------------------------------------

async function sendCAPIEvent(eventData: {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url?: string;
  user_data: Record<string, any>;
  custom_data: Record<string, any>;
  action_source: string;
}): Promise<boolean> {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return false;

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [eventData],
        access_token: META_ACCESS_TOKEN,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`CAPI: ${eventData.event_name} error:`, err);
      return false;
    }

    console.log(`CAPI: ${eventData.event_name} enviado | event_id: ${eventData.event_id}`);
    return true;
  } catch (err) {
    console.error(`CAPI: ${eventData.event_name} failed:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Custom Audience — add abandoner (Ponto 5)
// ---------------------------------------------------------------------------

async function addAbandonerToCustomAudience(email: string, phone?: string) {
  const audienceId = process.env.META_AUDIENCE_ABANDONERS_ID;
  if (!audienceId || !META_ACCESS_TOKEN) return;

  try {
    const schema = phone ? ["EMAIL", "PHONE"] : ["EMAIL"];
    const data = phone
      ? [[sha256(email), sha256(phone)]]
      : [[sha256(email)]];

    await fetch(`https://graph.facebook.com/v19.0/${audienceId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: { schema, data },
        access_token: META_ACCESS_TOKEN,
      }),
    });
    console.log("[AUDIENCE] Abandonador adicionado ao Custom Audience");
  } catch (err) {
    console.error("[AUDIENCE] Erro ao adicionar abandonador:", err);
  }
}

// ---------------------------------------------------------------------------
// CAPI InitiateCheckout helper
// ---------------------------------------------------------------------------

async function sendInitiateCheckout(
  eventId: string,
  customer: ReturnType<typeof extractCustomer>,
  payload: any
): Promise<void> {
  const userData: Record<string, any> = { country: sha256("br") };
  if (customer.email) userData.em = sha256(customer.email);
  if (customer.phone) userData.ph = sha256(customer.phone.replace(/\D/g, ""));
  if (customer.firstName) userData.fn = sha256(customer.firstName);
  if (payload.fbp) userData.fbp = payload.fbp;
  if (payload.fbc) userData.fbc = payload.fbc;

  await sendCAPIEvent({
    event_name: "InitiateCheckout",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `ic_${eventId}`,
    event_source_url: payload.checkout_url || undefined,
    user_data: userData,
    custom_data: {
      currency: "BRL",
      value: PRODUCT_PRICE,
      content_name: "56 Skills de Claude Code",
      content_type: "product",
    },
    action_source: "website",
  });
}

// ---------------------------------------------------------------------------
// Campaign matching helper
// ---------------------------------------------------------------------------

async function matchCampaign(utmCampaign?: string): Promise<string | undefined> {
  if (!utmCampaign) return undefined;

  // Try exact match first
  const exact = await prisma.campaign.findFirst({
    where: { name: utmCampaign },
  });
  if (exact) return exact.id;

  // Try contains match
  const similar = await prisma.campaign.findFirst({
    where: { name: { contains: utmCampaign, mode: "insensitive" } },
  });
  if (similar) return similar.id;

  return undefined;
}

// ---------------------------------------------------------------------------
// Metric entry increment helper
// ---------------------------------------------------------------------------

async function incrementDailyMetrics(
  campaignId: string,
  saleDate: Date,
  customerEmail?: string
) {
  const todayStart = new Date(saleDate);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(saleDate);
  todayEnd.setHours(23, 59, 59, 999);

  const existing = await prisma.metricEntry.findFirst({
    where: {
      campaignId,
      date: { gte: todayStart, lte: todayEnd },
      observations: { contains: "[Webhook]" },
    },
  });

  if (existing) {
    await prisma.metricEntry.update({
      where: { id: existing.id },
      data: {
        sales: existing.sales + 1,
        observations: `[Webhook] ${existing.sales + 1} vendas | ultima: ${customerEmail || "?"}`,
      },
    });
    console.log(`[Webhook] +1 venda (total: ${existing.sales + 1}) campaignId=${campaignId}`);
  } else {
    await prisma.metricEntry.create({
      data: {
        date: todayStart,
        campaignId,
        adSet: "Webhook Kirvano",
        investment: 0,
        impressions: 0,
        clicks: 0,
        sales: 1,
        observations: `[Webhook] 1 venda | ${customerEmail || "?"}`,
      },
    });
    console.log(`[Webhook] Nova metrica criada campaignId=${campaignId}`);
  }
}

// ---------------------------------------------------------------------------
// Sale creation helper (Melhoria 2)
// ---------------------------------------------------------------------------

async function createSale(payload: any, status: string) {
  const txId = extractTxId(payload);
  if (!txId) {
    throw new Error("webhook sem transaction_id/sale_id/id — rejeitado por idempotência");
  }
  const customer = extractCustomer(payload);
  const utm = extractUtm(payload);
  const metaIds = extractMetaIds(payload);
  const amountGross = extractAmount(payload);
  const amountNet = +(amountGross * (1 - KIRVANO_FEE_RATE)).toFixed(2);
  const paymentMethod = extractPaymentMethod(payload);
  const checkoutId = extractCheckoutId(payload);
  const saleDate = new Date(payload.created_at || payload.data_criacao || new Date());

  // Check for duplicate
  const existingSale = await prisma.sale.findUnique({ where: { kirvanoTxId: txId } });
  if (existingSale) {
    console.log(`[Webhook] Sale already exists for txId=${txId}, updating status to ${status}`);
    return prisma.sale.update({
      where: { kirvanoTxId: txId },
      data: { status },
    });
  }

  const campaignId = await matchCampaign(utm.utmCampaign);

  const sale = await prisma.sale.create({
    data: {
      date: saleDate,
      amountGross,
      amountNet,
      paymentMethod,
      status,
      kirvanoTxId: txId,
      kirvanoCheckoutId: checkoutId,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      customerName: customer.name,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
      ...utm,
      ...metaIds,
      campaignId: campaignId || undefined,
    },
  });

  console.log(`[Webhook] Sale created: id=${sale.id} txId=${txId} status=${status}`);
  return sale;
}

// ---------------------------------------------------------------------------
// Event handlers (Melhoria 3)
// ---------------------------------------------------------------------------

async function handleApproved(payload: any, res: Response) {
  const sale = await createSale(payload, "approved");

  // Send CAPI Purchase event (Melhoria 1)
  const capiSent = await sendCapiPurchaseEvent({
    id: sale.id,
    kirvanoTxId: sale.kirvanoTxId,
    amountGross: sale.amountGross,
    customerEmail: sale.customerEmail,
    customerPhone: sale.customerPhone,
    customerFirstName: sale.customerFirstName,
    customerLastName: sale.customerLastName,
  });

  if (capiSent) {
    await prisma.sale.update({
      where: { id: sale.id },
      data: {
        capiSent: true,
        capiSentAt: new Date(),
        capiEventId: sale.id,
      },
    });
  }

  // Melhoria 16: Add buyer to Custom Audience for exclusion/lookalike
  if (sale.customerEmail) {
    await addBuyerToCustomAudience(
      sale.customerEmail,
      sale.customerPhone ?? undefined,
    );
  }

  // Increment daily metrics if campaign is linked
  if (sale.campaignId) {
    await incrementDailyMetrics(sale.campaignId, sale.date, sale.customerEmail ?? undefined);
  } else {
    // Try to find/create a fallback campaign for metric tracking
    let fallback = await prisma.campaign.findFirst({
      where: { name: "Vendas Diretas" },
    });
    if (!fallback) {
      fallback = await prisma.campaign.findFirst({ orderBy: { createdAt: "asc" } });
    }
    if (!fallback) {
      fallback = await prisma.campaign.create({
        data: {
          name: "Vendas Diretas",
          type: "Organico",
          dailyBudget: 0,
          startDate: sale.date,
          status: "Ativa",
        },
      });
    }
    await incrementDailyMetrics(fallback.id, sale.date, sale.customerEmail ?? undefined);
  }

  res.json({ received: true, action: "sale_approved", saleId: sale.id, capiSent });
}

async function handleRefunded(payload: any, res: Response) {
  const txId = extractTxId(payload);
  if (!txId) {
    res.status(400).json({ error: "webhook sem transaction_id" });
    return;
  }
  const sale = await prisma.sale.findUnique({ where: { kirvanoTxId: txId } });

  if (!sale) {
    console.log(`[Webhook] Refund: sale not found for txId=${txId}`);
    res.json({ received: true, action: "refund_ignored", reason: "sale_not_found" });
    return;
  }

  await prisma.sale.update({
    where: { id: sale.id },
    data: { status: "refunded" },
  });

  console.log(`[Webhook] Sale refunded: txId=${txId}`);
  res.json({ received: true, action: "sale_refunded", saleId: sale.id });
}

async function handleChargeback(payload: any, res: Response) {
  const txId = extractTxId(payload);
  if (!txId) {
    res.status(400).json({ error: "webhook sem transaction_id" });
    return;
  }
  const sale = await prisma.sale.findUnique({ where: { kirvanoTxId: txId } });

  if (!sale) {
    console.log(`[Webhook] Chargeback: sale not found for txId=${txId}`);
    res.json({ received: true, action: "chargeback_ignored", reason: "sale_not_found" });
    return;
  }

  await prisma.sale.update({
    where: { id: sale.id },
    data: { status: "chargeback" },
  });

  console.log(`[Webhook] Sale chargeback: txId=${txId}`);
  res.json({ received: true, action: "sale_chargeback", saleId: sale.id });
}

async function handleCartAbandoned(payload: any, res: Response) {
  const customer = extractCustomer(payload);
  const utm = extractUtm(payload);

  const cart = await prisma.cartAbandonment.create({
    data: {
      date: new Date(payload.created_at || payload.data_criacao || new Date()),
      customerEmail: customer.email,
      customerPhone: customer.phone,
      customerName: customer.name,
      productId: payload.product?.id || payload.product_id || undefined,
      utmSource: utm.utmSource,
      utmCampaign: utm.utmCampaign,
      utmContent: utm.utmContent,
      checkoutUrl: payload.checkout_url || payload.checkout?.url || undefined,
    },
  });

  // Ponto 4: Enviar InitiateCheckout via CAPI
  await sendInitiateCheckout(cart.id, customer, payload);

  // Ponto 5: Adicionar ao Custom Audience de abandonadores
  if (customer.email) {
    await addAbandonerToCustomAudience(customer.email, customer.phone);
  }

  console.log(`[Webhook] Cart abandoned: id=${cart.id} email=${customer.email || "?"}`);
  res.json({ received: true, action: "cart_abandoned", cartId: cart.id });
}

async function handlePendingPayment(payload: any, status: string, res: Response) {
  const sale = await createSale(payload, status);
  const customer = extractCustomer(payload);

  // Ponto 4: Enviar InitiateCheckout via CAPI (se não veio de cart_abandoned recente)
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const recentCart = customer.email
    ? await prisma.cartAbandonment.findFirst({
        where: { customerEmail: customer.email, createdAt: { gte: thirtyMinAgo } },
      })
    : null;

  if (!recentCart) {
    await sendInitiateCheckout(sale.id, customer, payload);
  }

  console.log(`[Webhook] Pending payment created: txId=${sale.kirvanoTxId} status=${status}`);
  res.json({ received: true, action: `sale_${status}`, saleId: sale.id });
}

async function handleExpired(payload: any, res: Response) {
  const txId = extractTxId(payload);
  if (!txId) {
    res.status(400).json({ error: "webhook sem transaction_id" });
    return;
  }
  const sale = await prisma.sale.findUnique({ where: { kirvanoTxId: txId } });

  if (!sale) {
    console.log(`[Webhook] Expired: sale not found for txId=${txId}`);
    res.json({ received: true, action: "expired_ignored", reason: "sale_not_found" });
    return;
  }

  await prisma.sale.update({
    where: { id: sale.id },
    data: { status: "expired" },
  });

  console.log(`[Webhook] Sale expired: txId=${txId}`);
  res.json({ received: true, action: "sale_expired", saleId: sale.id });
}

async function handleRefused(payload: any, res: Response) {
  const sale = await createSale(payload, "refused");
  console.log(`[Webhook] Sale refused: txId=${sale.kirvanoTxId}`);
  res.json({ received: true, action: "sale_refused", saleId: sale.id });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/kirvano", async (req: Request, res: Response) => {
  try {
    // Validate token
    const token = req.headers["x-webhook-token"] || req.body?.token;
    if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const payload = req.body;
    const rawEvent = payload.event || payload.tipo_evento || payload.type || "";
    const event = normalizeEvent(rawEvent);

    console.log(`[Webhook Kirvano] event=${event}`, JSON.stringify(payload).slice(0, 500));

    // Product filter (optional — only reject if product ID is present and different)
    const productId = payload.product?.id || payload.produto?.id || payload.product_id;
    if (PRODUCT_ID && productId && productId !== PRODUCT_ID) {
      console.log(`[Webhook] Ignored: product ${productId} !== ${PRODUCT_ID}`);
      res.json({ received: true, action: "ignored", reason: "different_product" });
      return;
    }

    // Route by event type
    switch (event) {
      case "sale_approved":
      case "purchase_approved":
      case "approved":
      case "paid":
      case "compra_aprovada":
        await handleApproved(payload, res);
        break;

      case "sale_refunded":
      case "refunded":
      case "reembolso":
        await handleRefunded(payload, res);
        break;

      case "sale_chargeback":
      case "chargeback":
        await handleChargeback(payload, res);
        break;

      case "cart_abandoned":
      case "carrinho_abandonado":
        await handleCartAbandoned(payload, res);
        break;

      case "bank_slip_generated":
      case "boleto_generated":
      case "boleto_gerado":
        await handlePendingPayment(payload, "pending_boleto", res);
        break;

      case "bank_slip_expired":
      case "boleto_expired":
      case "boleto_expirado":
        await handleExpired(payload, res);
        break;

      case "pix_generated":
      case "pix_gerado":
        await handlePendingPayment(payload, "pending_pix", res);
        break;

      case "pix_expired":
      case "pix_expirado":
        await handleExpired(payload, res);
        break;

      case "sale_refused":
      case "refused":
      case "recusado":
        await handleRefused(payload, res);
        break;

      default:
        console.log(`[Webhook] Unhandled event: ${event}`);
        res.json({ received: true, action: "ignored", reason: `unhandled_event: ${event}` });
        break;
    }
  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
    res.status(500).json({ error: "Internal webhook processing error" });
  }
});

export default router;
