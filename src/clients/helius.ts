import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.js";
import type { HeliusBalancesResponse, HeliusFundedByResponse } from "../types.js";

const BASE_URL = "https://api.helius.xyz/v1/wallet";

async function heliusFetch<T>(url: string, retryCount = 2): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 429 && retryCount > 0) {
    await delay(1000);
    return heliusFetch<T>(url, retryCount - 1);
  }

  if (response.status === 404) {
    return null as T;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Helius request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

export async function fetchWalletBalances(address: string): Promise<HeliusBalancesResponse | null> {
  const params = new URLSearchParams({
    page: "1",
    limit: String(config.helius.historyLimit),
    showNative: "true",
    "api-key": config.helius.apiKey,
  });

  const url = `${BASE_URL}/${address}/balances?${params.toString()}`;
  return heliusFetch<HeliusBalancesResponse | null>(url);
}

export async function fetchFundedBy(address: string): Promise<HeliusFundedByResponse | null> {
  const params = new URLSearchParams({
    "api-key": config.helius.apiKey,
  });

  const url = `${BASE_URL}/${address}/funded-by?${params.toString()}`;
  return heliusFetch<HeliusFundedByResponse | null>(url);
}
