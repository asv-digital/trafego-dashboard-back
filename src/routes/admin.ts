import { Router, Request, Response } from "express";
import prisma from "../prisma";

const router = Router();

function authorized(req: Request): boolean {
  const expected = process.env.ADMIN_RESET_TOKEN;
  if (!expected) return false;
  const provided = req.header("x-admin-token") || req.query.token;
  return provided === expected;
}

router.post("/reset-test-data", async (req: Request, res: Response) => {
  if (!process.env.ADMIN_RESET_TOKEN) {
    return res.status(503).json({ error: "ADMIN_RESET_TOKEN not configured on server" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.query.confirm !== "true") {
    return res.status(400).json({ error: "missing ?confirm=true" });
  }

  const deleted: Record<string, number> = {};

  const r1 = await prisma.sale.deleteMany({});
  deleted.sales = r1.count;

  const r2 = await prisma.creativeTest.deleteMany({});
  deleted.creativeTests = r2.count;

  const r3 = await prisma.notificationLog.deleteMany({});
  deleted.notificationLogs = r3.count;

  const r4 = await prisma.adCommentSummary.deleteMany({});
  deleted.adCommentSummaries = r4.count;

  const r5 = await prisma.adComment.deleteMany({});
  deleted.adComments = r5.count;

  const r6 = await prisma.lookalikeAudience.deleteMany({});
  deleted.lookalikes = r6.count;

  const r7 = await prisma.cPMTrend.deleteMany({});
  deleted.cpmTrends = r7.count;

  const r8 = await prisma.agentHeartbeat.deleteMany({});
  deleted.heartbeats = r8.count;

  const r9 = await prisma.automationLock.deleteMany({});
  deleted.automationLocks = r9.count;

  const r10 = await prisma.adDiagnostic.deleteMany({});
  deleted.adDiagnostics = r10.count;

  const r11 = await prisma.actionLog.deleteMany({});
  deleted.actionLogs = r11.count;

  const r12 = await prisma.placementMetric.deleteMany({});
  deleted.placementMetrics = r12.count;

  const r13 = await prisma.dailySnapshot.deleteMany({});
  deleted.dailySnapshots = r13.count;

  const r14 = await prisma.cartAbandonment.deleteMany({});
  deleted.cartAbandonments = r14.count;

  const r15 = await prisma.campaign.deleteMany({});
  deleted.campaigns = r15.count;

  return res.json({
    status: "ok",
    deleted,
    preserved: ["AutomationConfig", "NotificationConfig", "MonthlyGoal"],
    timestamp: new Date().toISOString(),
  });
});

router.get("/meta-account-info", async (req: Request, res: Response) => {
  if (!process.env.ADMIN_RESET_TOKEN) {
    return res.status(503).json({ error: "ADMIN_RESET_TOKEN not configured on server" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = process.env.META_ACCESS_TOKEN || "";
  const account = process.env.META_AD_ACCOUNT_ID || "";
  if (!token || !account) {
    return res.status(400).json({ error: "META_ACCESS_TOKEN or META_AD_ACCOUNT_ID missing" });
  }

  const base = "https://graph.facebook.com/v19.0";
  const out: any = { ad_account_id: account };

  try {
    const r1 = await fetch(`${base}/${account}?fields=id,name,business,owner,account_status,currency&access_token=${encodeURIComponent(token)}`);
    out.account = await r1.json();
  } catch (err) {
    out.account_error = (err as Error).message;
  }

  try {
    const r2 = await fetch(`${base}/${account}/adspixels?fields=id,name,code&access_token=${encodeURIComponent(token)}`);
    out.pixels = await r2.json();
  } catch (err) {
    out.pixels_error = (err as Error).message;
  }

  try {
    const r3 = await fetch(`${base}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    out.me = await r3.json();
  } catch (err) {
    out.me_error = (err as Error).message;
  }

  return res.json(out);
});

export default router;
