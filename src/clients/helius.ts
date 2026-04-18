import {
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.js";
import { logDebug } from "../logger.js";
import type {
  HeliusBalancesResponse,
  HeliusEnhancedTransaction,
  HeliusFundedByResponse,
  TokenFirstTxFeeAnalysis,
} from "../types.js";

const BASE_URL = "https://api.helius.xyz/v1/wallet";
const RPC_URL = "https://mainnet.helius-rpc.com";
const ENHANCED_RPC_URL = "https://api-mainnet.helius-rpc.com";
let nextHeliusRequestAt = 0;
let heliusQueue = Promise.resolve();
const connection = new Connection(`${RPC_URL}/?api-key=${config.helius.apiKey}`, "confirmed");

type HeliusRpcTransactionResponse = {
  transaction: {
    message: {
      getAccountKeys(args: { accountKeysFromLookups?: unknown }): {
        get(index: number): { equals(value: typeof ComputeBudgetProgram.programId): boolean } | undefined;
      };
      compiledInstructions: Array<{
        programIdIndex: number;
        data: Uint8Array;
      }>;
    };
  };
  meta?: {
    loadedAddresses?: unknown;
    computeUnitsConsumed?: number;
    fee?: number;
  } | null;
};

async function waitForHeliusTurn(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextHeliusRequestAt - now);
  if (waitMs > 0) {
    await delay(waitMs);
  }

  nextHeliusRequestAt = Date.now() + config.helius.minRequestIntervalMs;
}

async function withHeliusThrottle<T>(task: () => Promise<T>): Promise<T> {
  const run = heliusQueue.then(async () => {
    await waitForHeliusTurn();
    return task();
  });

  heliusQueue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

function readU32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readU64LE(buf: Buffer, offset: number): number {
  return Number(buf.readBigUInt64LE(offset));
}

async function heliusFetch<T>(url: string, retryCount = 2, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await withHeliusThrottle(() =>
      fetch(
        url,
        init ?? {
          headers: {
            Accept: "application/json",
          },
        },
      ),
    );
  } catch (error) {
    if (retryCount > 0) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug(`Helius network fetch failed; retrying after backoff: ${message}`);
      await delay(config.helius.rateLimitBackoffMs);
      return heliusFetch<T>(url, retryCount - 1, init);
    }

    throw error;
  }

  if (response.status === 429 && retryCount > 0) {
    logDebug("Helius request was rate limited; retrying after backoff.");
    await delay(config.helius.rateLimitBackoffMs);
    return heliusFetch<T>(url, retryCount - 1, init);
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
  try {
    return await heliusFetch<HeliusBalancesResponse | null>(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`balances fetch failed: ${message}`);
  }
}

export async function fetchFundedBy(address: string): Promise<HeliusFundedByResponse | null> {
  const params = new URLSearchParams({
    "api-key": config.helius.apiKey,
  });

  const url = `${BASE_URL}/${address}/funded-by?${params.toString()}`;
  try {
    return await heliusFetch<HeliusFundedByResponse | null>(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`funded-by fetch failed: ${message}`);
  }
}

async function fetchDevCreateTransactions(creator: string): Promise<HeliusEnhancedTransaction[]> {
  const params = new URLSearchParams({
    "token-accounts": "none",
    "sort-order": "desc",
    "api-key": config.helius.apiKey,
    type: "CREATE",
    limit: String(config.filters.maxDevCreatedTokens + 1),
  });

  const url = `${ENHANCED_RPC_URL}/v0/addresses/${creator}/transactions?${params.toString()}`;
  try {
    return await heliusFetch<HeliusEnhancedTransaction[]>(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`dev CREATE transactions fetch failed: ${message}`);
  }
}

export async function fetchNextPatternAddressTransaction(
  patternAddress: string,
  afterSignature: string,
  tokenMint: string,
  creator: string,
): Promise<{ transaction: HeliusEnhancedTransaction | null; programCount: number | null }> {
  const params = new URLSearchParams({
    "token-accounts": "none",
    "sort-order": "asc",
    "api-key": config.helius.apiKey,
    limit: "20",
    "after-signature": afterSignature,
  });

  const url = `${ENHANCED_RPC_URL}/v0/addresses/${patternAddress}/transactions?${params.toString()}`;
  try {
    const transactions = await heliusFetch<HeliusEnhancedTransaction[]>(url);
    const transaction =
      transactions.find(
        (tx) =>
          tx.feePayer &&
          tx.feePayer !== creator &&
          tx.tokenTransfers?.some((transfer) => transfer.mint === tokenMint && transfer.toUserAccount === tx.feePayer),
      ) ?? null;
    return {
      transaction,
      programCount: transaction ? countUniquePrograms(transaction) : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pattern-address next transaction fetch failed: ${message}`);
  }
}

function countUniquePrograms(transaction: HeliusEnhancedTransaction): number {
  const programs = new Set<string>();

  for (const instruction of transaction.instructions ?? []) {
    if (instruction.programId) {
      programs.add(instruction.programId);
    }

    for (const innerInstruction of instruction.innerInstructions ?? []) {
      if (innerInstruction.programId) {
        programs.add(innerInstruction.programId);
      }
    }
  }

  return programs.size;
}

async function fetchTransactionFeeDissection(signature: string, retryCount = 2): Promise<{
  computeUnitLimit: number | null;
  computeUnitPriceMicroLamports: number | null;
  priorityFeeLamports: number | null;
  priorityFeeAtConsumedUnitsLamports: number | null;
  computeUnitsConsumed: number | null;
  totalFeeLamports: number | null;
  priorityFeeSol: number | null;
  priorityFeeAtConsumedUnitsSol: number | null;
}> {
  let tx: HeliusRpcTransactionResponse | null;

  try {
    const rawTx = await withHeliusThrottle(() =>
      connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      }),
    );
    tx = rawTx as HeliusRpcTransactionResponse | null;
  } catch (error) {
    if (retryCount > 0) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug(`Helius getTransaction failed; retrying after backoff: ${message}`);
      await delay(config.helius.rateLimitBackoffMs);
      return fetchTransactionFeeDissection(signature, retryCount - 1);
    }

    throw error;
  }

  if (!tx) {
    throw new Error("transaction not found");
  }

  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  let computeUnitLimit: number | null = null;
  let computeUnitPriceMicroLamports: number | null = null;

  for (const instruction of message.compiledInstructions) {
    const programId = accountKeys.get(instruction.programIdIndex);
    if (!programId?.equals(ComputeBudgetProgram.programId)) {
      continue;
    }

    const data = Buffer.from(instruction.data);
    const discriminator = data[0];

    if (discriminator === 2 && data.length >= 5) {
      computeUnitLimit = readU32LE(data, 1);
    } else if (discriminator === 3 && data.length >= 9) {
      computeUnitPriceMicroLamports = readU64LE(data, 1);
    }
  }

  const priorityFeeLamports =
    computeUnitLimit !== null && computeUnitPriceMicroLamports !== null
      ? Math.ceil((computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000)
      : null;
  const priorityFeeAtConsumedUnitsLamports =
    tx.meta?.computeUnitsConsumed !== undefined && computeUnitPriceMicroLamports !== null
      ? Math.ceil((tx.meta.computeUnitsConsumed * computeUnitPriceMicroLamports) / 1_000_000)
      : null;

  return {
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    priorityFeeLamports,
    priorityFeeAtConsumedUnitsLamports,
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    totalFeeLamports: tx.meta?.fee ?? null,
    priorityFeeSol: priorityFeeLamports === null ? null : priorityFeeLamports / 1_000_000_000,
    priorityFeeAtConsumedUnitsSol:
      priorityFeeAtConsumedUnitsLamports === null ? null : priorityFeeAtConsumedUnitsLamports / 1_000_000_000,
  };
}

async function analyzeFirstTokenTransaction(firstTx: HeliusEnhancedTransaction): Promise<TokenFirstTxFeeAnalysis> {
  if (!firstTx.signature) {
    throw new Error("matching CREATE transaction returned without signature");
  }

  const nativeTransfers = firstTx.nativeTransfers ?? [];
  const secondToLastTransfer = nativeTransfers[nativeTransfers.length - 2];
  const largestAmount =
    nativeTransfers.length > 0
      ? Math.max(...nativeTransfers.map((transfer) => (typeof transfer.amount === "number" ? transfer.amount : Number.NEGATIVE_INFINITY)))
      : null;
  const hasSupportedTransferLength = nativeTransfers.length === 8 || nativeTransfers.length === 10;
  const sharedPatternAddress =
    nativeTransfers.length === 8
      ? nativeTransfers[5]?.toUserAccount ?? null
      : nativeTransfers[6]?.toUserAccount && nativeTransfers[6]?.toUserAccount === nativeTransfers[7]?.toUserAccount
        ? nativeTransfers[6]?.toUserAccount
        : null;
  const nativePatternMatched =
    hasSupportedTransferLength &&
    Boolean(nativeTransfers[0]?.toUserAccount) &&
    nativeTransfers[0]?.toUserAccount === nativeTransfers[3]?.toUserAccount &&
    nativeTransfers[2]?.amount === 2074080 &&
    nativeTransfers[4]?.amount === 2074080 &&
    typeof secondToLastTransfer?.amount === "number" &&
    secondToLastTransfer.amount === largestAmount &&
    Boolean(sharedPatternAddress);

  const feeDissection = await fetchTransactionFeeDissection(firstTx.signature);
  const totalFeeLamports = feeDissection.totalFeeLamports ?? (typeof firstTx.fee === "number" ? firstTx.fee : null);
  const feeDifferenceLamports =
    totalFeeLamports === null || feeDissection.priorityFeeLamports === null
      ? null
      : totalFeeLamports - feeDissection.priorityFeeLamports;
  const expectedBaseFeeLamports = Math.round(config.filters.firstTxFeeDifferenceSol * 1_000_000_000);
  const tipFeeLamports = feeDifferenceLamports === null ? null : Math.max(feeDifferenceLamports - expectedBaseFeeLamports, 0);

  return {
    signature: firstTx.signature,
    computeUnitLimit: feeDissection.computeUnitLimit,
    computeUnitPriceMicroLamports: feeDissection.computeUnitPriceMicroLamports,
    priorityFeeLamports: feeDissection.priorityFeeLamports,
    priorityFeeAtConsumedUnitsLamports: feeDissection.priorityFeeAtConsumedUnitsLamports,
    computeUnitsConsumed: feeDissection.computeUnitsConsumed,
    totalFeeLamports,
    priorityFeeSol: feeDissection.priorityFeeSol,
    priorityFeeAtConsumedUnitsSol: feeDissection.priorityFeeAtConsumedUnitsSol,
    totalFeeSol: totalFeeLamports === null ? null : totalFeeLamports / 1_000_000_000,
    totalMinusPriorityFeeSol: feeDifferenceLamports === null ? null : feeDifferenceLamports / 1_000_000_000,
    tipFeeLamports,
    tipFeeSol: tipFeeLamports === null ? null : tipFeeLamports / 1_000_000_000,
    feePayer: firstTx.feePayer ?? null,
    source: firstTx.source ?? null,
    type: firstTx.type ?? null,
    timestamp: firstTx.timestamp ?? null,
    firstTxFeeLamports: totalFeeLamports,
    nativeTransferCount: nativeTransfers.length,
    nativePatternMatched,
    nativePatternAddress: nativePatternMatched ? sharedPatternAddress : null,
    patternNextTxSignature: null,
    patternNextTxTimestamp: null,
    patternNextTxFeePayer: null,
    patternNextTxProgramCount: null,
  };
}

export async function fetchDevCreateTransactionFeeAnalysis(
  creator: string,
  tokenMint: string,
): Promise<{ analysis: TokenFirstTxFeeAnalysis | null; reason: string | null; devCreatedTokenCount: number }> {
  let devCreatedTokenCount = 0;

  for (let attempt = 0; attempt <= config.helius.devCreateFetchRetries; attempt += 1) {
    const transactions = await fetchDevCreateTransactions(creator);
    devCreatedTokenCount = transactions.length;
    const matchingTx =
      transactions.find((tx) => tx.tokenTransfers?.some((transfer) => transfer.mint === tokenMint)) ?? null;

    logDebug(
      `Fetched ${devCreatedTokenCount} dev CREATE transaction(s) for ${creator}; matching mint ${tokenMint} ${
        matchingTx?.signature ? `found in ${matchingTx.signature}` : "not found"
      }${attempt > 0 ? ` after ${attempt} retry attempt(s)` : ""}.`,
    );

    if (matchingTx?.signature) {
      const initialFeeLamports = typeof matchingTx.fee === "number" ? matchingTx.fee : null;
      if (initialFeeLamports === null) {
        return {
          analysis: null,
          reason: "matching dev CREATE transaction returned without a fee",
          devCreatedTokenCount,
        };
      }

      if (
        initialFeeLamports < config.filters.minFirstTxFeeLamports ||
        initialFeeLamports > config.filters.maxFirstTxFeeLamports
      ) {
        return {
          analysis: null,
          reason: `first token transaction fee is ${initialFeeLamports} lamports`,
          devCreatedTokenCount,
        };
      }

      return {
        analysis: await analyzeFirstTokenTransaction(matchingTx),
        reason: null,
        devCreatedTokenCount,
      };
    }

    if (attempt < config.helius.devCreateFetchRetries) {
      logDebug(
        `Dev CREATE transaction for ${tokenMint} is not indexed yet; retrying in ${config.helius.devCreateRetryDelayMs}ms.`,
      );
      await delay(config.helius.devCreateRetryDelayMs);
    }
  }

  return {
    analysis: null,
    reason:
      devCreatedTokenCount >= config.filters.maxDevCreatedTokens + 1
        ? `no matching dev CREATE transaction found in latest ${devCreatedTokenCount} CREATE transactions after retries`
        : "no dev CREATE transaction matched token mint after retries",
    devCreatedTokenCount,
  };
}
