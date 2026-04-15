import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import type { JupiterExecuteResponse, JupiterOrderResponse } from "../types.js";

const ULTRA_BASE_URL = "https://ultra-api.jup.ag/ultra/v1";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

function getHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (config.jupiter.apiKey) {
    headers["x-api-key"] = config.jupiter.apiKey;
  }

  return headers;
}

async function jupiterFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...getHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jupiter request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

function getBuyerKeypair(): any {
  if (!config.jupiter.privateKeyBase58) {
    throw new Error("Missing SOLANA_PRIVATE_KEY_B58 for live Jupiter buys.");
  }

  return Keypair.fromSecretKey(bs58.decode(config.jupiter.privateKeyBase58));
}

export function canExecuteLiveBuy(): boolean {
  return Boolean(config.jupiter.enableLiveBuy && config.jupiter.privateKeyBase58);
}

export function getBuyerPublicKey(): string | null {
  if (!config.jupiter.privateKeyBase58) {
    return null;
  }

  return getBuyerKeypair().publicKey.toBase58();
}

export async function createUltraOrder(outputMint: string): Promise<JupiterOrderResponse> {
  const taker = getBuyerPublicKey();
  if (!taker) {
    throw new Error("Cannot create Jupiter Ultra order without SOLANA_PRIVATE_KEY_B58.");
  }

  const amountLamports = Math.round(config.jupiter.buyAmountSol * 1_000_000_000);
  const params = new URLSearchParams({
    inputMint: config.jupiter.inputMint,
    outputMint,
    amount: String(amountLamports),
    taker,
  });

  if (config.jupiter.broadcastFeeType) {
    params.set("broadcastFeeType", config.jupiter.broadcastFeeType);
  }

  if (config.jupiter.priorityFeeLamports > 0) {
    params.set("priorityFeeLamports", String(config.jupiter.priorityFeeLamports));
  }

  if (config.jupiter.jitoTipLamports > 0) {
    params.set("jitoTipLamports", String(config.jupiter.jitoTipLamports));
  }

  const url = `${ULTRA_BASE_URL}/order?${params.toString()}`;
  return jupiterFetch<JupiterOrderResponse>(url, { method: "GET" });
}

export async function executeUltraOrder(order: JupiterOrderResponse): Promise<JupiterExecuteResponse> {
  const keypair = getBuyerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  const transactionBuffer = Buffer.from(order.transaction, "base64");
  const transaction = VersionedTransaction.deserialize(transactionBuffer);
  transaction.sign([keypair]);

  const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  const payload = {
    signedTransaction,
    requestId: order.requestId,
  };

  const executeResponse = await jupiterFetch<JupiterExecuteResponse>(`${ULTRA_BASE_URL}/execute`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (executeResponse.signature) {
    await connection.confirmTransaction(executeResponse.signature, "confirmed");
  }

  return executeResponse;
}
