import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Limpa dados existentes
  await prisma.metricEntry.deleteMany();
  await prisma.creative.deleteMany();
  await prisma.campaign.deleteMany();

  // Campanha 1 — Remarketing Quente
  const camp1 = await prisma.campaign.create({
    data: {
      name: "CAMP 1 — Remarketing Quente",
      type: "Remarketing",
      audience: "Engajou IG @jp.asv 30-90d",
      dailyBudget: 150,
      startDate: new Date("2026-04-07"),
      status: "Ativa",
    },
  });

  // Campanha 2 — Prospecção Frio + LAL
  const camp2 = await prisma.campaign.create({
    data: {
      name: "CAMP 2 — Prospecção Frio + LAL",
      type: "Prospecção",
      audience: "LAL 1% + Interesses Empreendedorismo/Tech",
      dailyBudget: 150,
      startDate: new Date("2026-04-07"),
      status: "Aprendizado",
    },
  });

  // Métricas — Remarketing
  await prisma.metricEntry.createMany({
    data: [
      {
        date: new Date("2026-04-07"),
        campaignId: camp1.id,
        adSet: "Engajou IG 30d",
        investment: 150,
        impressions: 8500,
        clicks: 195,
        sales: 4,
        frequency: 1.2,
        hookRate: 38,
      },
      {
        date: new Date("2026-04-12"),
        campaignId: camp1.id,
        adSet: "Engajou IG 30d",
        investment: 250,
        impressions: 14200,
        clicks: 340,
        sales: 7,
        frequency: 1.8,
        hookRate: 35,
      },
    ],
  });

  // Métricas — Prospecção
  await prisma.metricEntry.createMany({
    data: [
      {
        date: new Date("2026-04-07"),
        campaignId: camp2.id,
        adSet: "LAL 1% Compradores",
        investment: 150,
        impressions: 12000,
        clicks: 156,
        sales: 2,
        frequency: 1.0,
        hookRate: 22,
      },
      {
        date: new Date("2026-04-12"),
        campaignId: camp2.id,
        adSet: "LAL 1% Compradores",
        investment: 250,
        impressions: 19500,
        clicks: 273,
        sales: 4,
        frequency: 1.3,
        hookRate: 26,
      },
    ],
  });

  // Criativos
  await prisma.creative.createMany({
    data: [
      {
        name: "JP Talking Head — Hook Custo Equipe",
        type: "Vídeo Talking Head",
        status: "Ativo",
        ctr: 2.3,
        hookRate: 38,
        cpa: 37.5,
        campaignId: camp1.id,
        createdAt: new Date("2026-04-07"),
      },
      {
        name: "Screen Recording — Skill em 30s",
        type: "Screen Recording",
        status: "Ativo",
        ctr: 1.8,
        hookRate: 26,
        cpa: 52.0,
        campaignId: camp1.id,
        createdAt: new Date("2026-04-07"),
      },
      {
        name: "Carrossel 8 Funções",
        type: "Carrossel",
        status: "Ativo",
        ctr: 1.1,
        hookRate: null,
        cpa: 68.0,
        campaignId: camp2.id,
        createdAt: new Date("2026-04-07"),
      },
    ],
  });

  console.log("Seed completed successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
