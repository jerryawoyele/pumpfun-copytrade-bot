import { fetchDevCreateTransactionFeeAnalysis, fetchFundedBy, fetchNextPatternAddressTransaction } from "./src/clients/helius.js";
import { config } from "./src/config.js";
import { FirstTxPatternState } from "./src/state.js";
import type { HeliusFundedByResponse, TokenFirstTxFeeAnalysis } from "./src/types.js";

const TOKEN_MINT = "";
const LAMPORTS_PER_SOL = 1_000_000_000;

type StepResult = {
  name: string;
  passed: boolean;
  detail: string;
};

function getTargetMint(): string {
  const cliMint = process.argv[2]?.trim();
  const mint = cliMint || TOKEN_MINT.trim();
  if (!mint) {
    throw new Error('Set TOKEN_MINT in test.ts or pass one with: npm run test:filters -- <TOKEN_MINT>');
  }

  return mint;
}

function addStep(steps: StepResult[], name: string, passed: boolean, detail: string): boolean {
  steps.push({ name, passed, detail });
  return passed;
}

function getExchangeTypeForFunding(funding: HeliusFundedByResponse | null): string | null {
  const normalizedType = funding?.funderType?.trim().toLowerCase();
  return normalizedType === "centralized exchange" ? funding?.funderType ?? null : null;
}

function getNativeTransferPatternReasons(firstTxFee: TokenFirstTxFeeAnalysis): string[] {
  const reasons: string[] = [];

  if (!firstTxFee.nativePatternMatched) {
    reasons.push(`native transfer pattern failed with ${firstTxFee.nativeTransferCount} transfers`);
  }

  if (!firstTxFee.nativePatternAddress) {
    reasons.push("pattern address is missing");
  }

  return reasons;
}

function getFeeAndTipReasons(firstTxFee: TokenFirstTxFeeAnalysis): string[] {
  const reasons: string[] = [];
  const targetFeeDifferenceLamports = Math.round(config.filters.firstTxFeeDifferenceSol * LAMPORTS_PER_SOL);

  if (firstTxFee.firstTxFeeLamports === null) {
    reasons.push("first tx fee is missing");
  } else if (
    firstTxFee.firstTxFeeLamports < config.filters.minFirstTxFeeLamports ||
    firstTxFee.firstTxFeeLamports > config.filters.maxFirstTxFeeLamports
  ) {
    reasons.push(`first tx fee is ${firstTxFee.firstTxFeeLamports} lamports`);
  }

  if (firstTxFee.priorityFeeLamports === null) {
    reasons.push("priority fee could not be decoded");
  } else if (firstTxFee.totalFeeLamports === null) {
    reasons.push("total fee is missing");
  } else if (firstTxFee.totalFeeLamports - firstTxFee.priorityFeeLamports !== targetFeeDifferenceLamports) {
    reasons.push(`fee difference is ${(firstTxFee.totalFeeLamports - firstTxFee.priorityFeeLamports) / LAMPORTS_PER_SOL} SOL`);
  }

  if (firstTxFee.tipFeeLamports === null) {
    reasons.push("tip fee could not be calculated");
  } else if (firstTxFee.tipFeeLamports !== 0) {
    reasons.push(`tip fee is ${firstTxFee.tipFeeSol} SOL`);
  }

  return reasons;
}

function printResults(steps: StepResult[]): void {
  console.log("\nFilter results:");
  for (const step of steps) {
    console.log(`${step.passed ? "PASS" : "FAIL"} | ${step.name} | ${step.detail}`);
  }

  const passed = steps.every((step) => step.passed);
  console.log(`\nFINAL: ${passed ? "PASS" : "FAIL"}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const steps: StepResult[] = [];
  const tokenMint = getTargetMint();

  console.log(`Testing token mint: ${tokenMint}`);
  addStep(steps, "mint suffix", tokenMint.endsWith("pump"), tokenMint.endsWith("pump") ? "mint ends with pump" : "mint does not end with pump");
  if (!tokenMint.endsWith("pump")) {
    printResults(steps);
    return;
  }

  const tokenFunding = await fetchFundedBy(tokenMint);
  const creator = tokenFunding?.funder ?? "";
  const createdTimestamp = tokenFunding?.timestamp ?? 0;
  addStep(
    steps,
    "derive creator from token funded-by",
    Boolean(creator && createdTimestamp),
    creator ? `creator=${creator}, created_at=${new Date(createdTimestamp * 1000).toISOString()}` : "token funded-by returned no creator",
  );
  if (!creator || !createdTimestamp) {
    printResults(steps);
    return;
  }

  const creatorFunding = await fetchFundedBy(creator);
  const exchangeType = getExchangeTypeForFunding(creatorFunding);
  addStep(
    steps,
    "creator direct exchange funding",
    !config.filters.requireExchangeFunder || Boolean(exchangeType),
    exchangeType
      ? `funder=${creatorFunding?.funder}, funder_type=${exchangeType}`
      : `funder_type=${creatorFunding?.funderType ?? "unknown"}`,
  );

  const fundingAmount = creatorFunding?.symbol === "SOL" ? creatorFunding.amount : null;
  addStep(
    steps,
    "creator funding amount",
    fundingAmount !== null && fundingAmount >= config.filters.minFundingSol && fundingAmount <= config.filters.maxFundingSol,
    fundingAmount === null
      ? "funding amount is missing or not SOL"
      : `amount=${fundingAmount} SOL, range=${config.filters.minFundingSol}-${config.filters.maxFundingSol} SOL`,
  );

  const fundingLagHours = creatorFunding ? (createdTimestamp - creatorFunding.timestamp) / 3600 : null;
  addStep(
    steps,
    "creator funding lag",
    fundingLagHours !== null &&
      fundingLagHours >= config.filters.minFundingHoursBeforeCreation &&
      fundingLagHours <= config.filters.maxFundingHoursBeforeCreation,
    fundingLagHours === null
      ? "funding lag could not be calculated"
      : `lag=${fundingLagHours.toFixed(4)}h, range=${config.filters.minFundingHoursBeforeCreation}-${config.filters.maxFundingHoursBeforeCreation}h`,
  );

  if (!steps.every((step) => step.passed)) {
    printResults(steps);
    return;
  }

  const firstTxResult = await fetchDevCreateTransactionFeeAnalysis(creator, tokenMint);
  addStep(
    steps,
    "matching dev CREATE transaction",
    Boolean(firstTxResult.analysis),
    firstTxResult.analysis
      ? `signature=${firstTxResult.analysis.signature}`
      : `not found or invalid: ${firstTxResult.reason ?? "unknown reason"}`,
  );

  addStep(
    steps,
    "dev created token count",
    firstTxResult.devCreatedTokenCount <= config.filters.maxDevCreatedTokens,
    `count=${firstTxResult.devCreatedTokenCount}, max=${config.filters.maxDevCreatedTokens}`,
  );

  if (!firstTxResult.analysis) {
    printResults(steps);
    return;
  }

  const nativeReasons = getNativeTransferPatternReasons(firstTxResult.analysis);
  addStep(
    steps,
    "native transfer pattern",
    nativeReasons.length === 0,
    nativeReasons.length === 0
      ? `transfers=${firstTxResult.analysis.nativeTransferCount}, pattern_address=${firstTxResult.analysis.nativePatternAddress}`
      : nativeReasons.join(", "),
  );

  if (nativeReasons.length === 0 && firstTxResult.analysis.nativePatternAddress) {
    const nextPatternTx = await fetchNextPatternAddressTransaction(
      firstTxResult.analysis.nativePatternAddress,
      firstTxResult.analysis.signature,
      tokenMint,
      creator,
    );
    addStep(
      steps,
      "next pattern-address transaction",
      Boolean(nextPatternTx.transaction?.signature),
      nextPatternTx.transaction?.signature
        ? `signature=${nextPatternTx.transaction.signature}, time=${nextPatternTx.transaction.timestamp ? new Date(nextPatternTx.transaction.timestamp * 1000).toISOString() : "unknown"}, fee_payer=${nextPatternTx.transaction.feePayer ?? "unknown"}`
        : "no fee-payer buy transaction returned in post-create window",
    );

    addStep(
      steps,
      "next pattern-address tx program count",
      nextPatternTx.programCount === 5 || nextPatternTx.programCount === 7,
      `program_count=${nextPatternTx.programCount ?? "unknown"}, required=5 or 7`,
    );

    if (nextPatternTx.transaction?.feePayer) {
      addStep(
        steps,
        "next pattern-address tx fee payer is not creator",
        nextPatternTx.transaction.feePayer !== creator,
        nextPatternTx.transaction.feePayer === creator
          ? "fee payer is the token creator"
          : `fee_payer=${nextPatternTx.transaction.feePayer}, creator=${creator}`,
      );

      const feePayerReceivesToken = nextPatternTx.transaction.tokenTransfers?.some(
        (transfer) => transfer.mint === tokenMint && transfer.toUserAccount === nextPatternTx.transaction?.feePayer,
      );
      addStep(
        steps,
        "next pattern-address tx is fee-payer buy",
        Boolean(feePayerReceivesToken),
        feePayerReceivesToken
          ? "fee payer receives this token in tokenTransfers"
          : "fee payer does not receive this token in tokenTransfers",
      );
    }
  }

  const feeReasons = getFeeAndTipReasons(firstTxResult.analysis);
  addStep(
    steps,
    "fee and zero-tip",
    feeReasons.length === 0,
    feeReasons.length === 0
      ? `fee=${firstTxResult.analysis.firstTxFeeLamports} lamports, priority=${firstTxResult.analysis.priorityFeeSol} SOL, fee_difference=${firstTxResult.analysis.totalMinusPriorityFeeSol} SOL, tip=${firstTxResult.analysis.tipFeeSol} SOL`
      : feeReasons.join(", "),
  );

  if (firstTxResult.analysis.nativePatternAddress) {
    const state = await FirstTxPatternState.create();
    const matches = state.getMatches(firstTxResult.analysis.nativePatternAddress).filter((match) => match.tokenMint !== tokenMint);
    addStep(
      steps,
      "pattern-address uniqueness",
      matches.length === 0,
      matches.length === 0
        ? "no previous passed token used this pattern address"
        : `already seen on ${matches.length} token(s): ${matches.map((match) => `${match.symbol}:${match.tokenMint}`).join(", ")}`,
    );
  }

  printResults(steps);
}

await main();
