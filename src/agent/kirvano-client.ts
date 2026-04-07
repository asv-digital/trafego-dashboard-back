import type { AgentConfig, KirvanoTransaction, KirvanoResponse } from "./types";

const BASE_URL = "https://api.kirvano.com/v1";

export class KirvanoClient {
  private apiKey: string;
  private productId: string;

  constructor(config: AgentConfig["kirvano"]) {
    this.apiKey = config.api_key;
    this.productId = config.product_id;
  }

  /** Fetch approved transactions for a date range */
  async getTransactions(dateFrom: string, dateTo: string): Promise<KirvanoTransaction[]> {
    const allTransactions: KirvanoTransaction[] = [];
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage) {
      const params = new URLSearchParams({
        product_id: this.productId,
        status: "approved",
        start_date: dateFrom,
        end_date: dateTo,
        page: String(page),
        per_page: "100",
      });

      const res = await fetch(`${BASE_URL}/transactions?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Kirvano API error ${res.status}: ${err}`);
      }

      const json = (await res.json()) as KirvanoResponse;
      allTransactions.push(...json.data);

      lastPage = json.meta?.last_page ?? 1;
      page++;
    }

    return allTransactions;
  }

  /** Count sales per day from transactions */
  static groupByDate(transactions: KirvanoTransaction[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const tx of transactions) {
      const date = tx.created_at.split("T")[0]; // YYYY-MM-DD
      map.set(date, (map.get(date) ?? 0) + 1);
    }
    return map;
  }
}
