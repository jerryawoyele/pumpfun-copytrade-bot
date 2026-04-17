import {
  Connection,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  type LoadedAddresses,
} from "@solana/web3.js";
import "dotenv/config";

const DEFAULT_SIGNATURE =
  "5HEfNpTbfMmS9G4vRHRkwYiUNJwAFnQVmwGeHgXAo5g6YpAdmUhosXLYvJ3u5rwBpK3NyTvEz6JrX6rRKsmQzBFS";

const signature = process.argv[2] ?? DEFAULT_SIGNATURE;
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
 

const connection = new Connection(rpcUrl, "confirmed");

function readU32LE(buf: Buffer, offset: number) {
  return buf.readUInt32LE(offset);
}

function readU64LE(buf: Buffer, offset: number) {
  return Number(buf.readBigUInt64LE(offset));
}

async function getPriorityFeeFromTx(
  connection: Connection,
  signature: string
) {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx) throw new Error("Transaction not found");

  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses as LoadedAddresses | null,
  });

  let computeUnitLimit: number | null = null;
  let computeUnitPriceMicroLamports: number | null = null;

  const instructions = message.compiledInstructions;

  for (const ix of instructions) {
    const programId = accountKeys.get(ix.programIdIndex);

    if (!programId?.equals(ComputeBudgetProgram.programId)) continue;

    const data = Buffer.from(ix.data);

    const discriminator = data[0];

    // ComputeBudget instruction tags:
    // 2 = SetComputeUnitLimit(u32)
    // 3 = SetComputeUnitPrice(u64)
    if (discriminator === 2 && data.length >= 5) {
      computeUnitLimit = readU32LE(data, 1);
    } else if (discriminator === 3 && data.length >= 9) {
      computeUnitPriceMicroLamports = readU64LE(data, 1);
    }
  }

  const priorityFeeLamports =
    computeUnitLimit != null && computeUnitPriceMicroLamports != null
      ? Math.ceil(
          (computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000
        )
      : 0;

  return {
    signature,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    priorityFeeLamports,
    priorityFeeAtConsumedUnitsLamports:
      tx.meta?.computeUnitsConsumed != null &&
      computeUnitPriceMicroLamports != null
        ? Math.ceil(
            (tx.meta.computeUnitsConsumed * computeUnitPriceMicroLamports) /
              1_000_000
          )
        : null,
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    totalFeeLamports: tx.meta?.fee ?? null,
  };
}

const result = await getPriorityFeeFromTx(connection, signature);

console.log({
  ...result,
  priorityFeeSol: result.priorityFeeLamports / LAMPORTS_PER_SOL,
  priorityFeeAtConsumedUnitsSol:
    result.priorityFeeAtConsumedUnitsLamports == null
      ? null
      : result.priorityFeeAtConsumedUnitsLamports / LAMPORTS_PER_SOL,
  totalFeeSol:
    result.totalFeeLamports == null
      ? null
      : result.totalFeeLamports / LAMPORTS_PER_SOL,
});
