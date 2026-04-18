import { fetchDevCreateTransactionFeeAnalysis, fetchFundedBy, fetchNextPatternAddressTransaction } from "./clients/helius.js";
import { canExecuteLiveBuy, createUltraOrder, executeUltraOrder } from "./clients/jupiter.js";
import { enrichTokenWithGmgnSocials } from "./clients/gmgn.js";
import { normalizePumpPortalToken } from "./clients/pumpportal.js";
import { config } from "./config.js";
import { analyzeCreatorFunding, getXCommunityLink, isXCommunityUrl } from "./filters.js";
import { logDebug, logFound, logInfo, logSignal, logSuccess, logWarn } from "./logger.js";
import { BuyState, FirstTxPatternState } from "./state.js";
import type { CandidateResult, GmgnTrenchToken, HeliusFundedByResponse, PumpPortalNewTokenEvent, TokenFirstTxFeeAnalysis } from "./types.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const CANDIDATE_LOG_DIVIDER = "=".repeat(96);

function getTokenLabel(token: Pick<GmgnTrenchToken, "symbol" | "name" | "address">): string {
  return `${token.symbol || token.name || "unknown"} ${token.address}`;
}

function logCandidateBlockStart(token: Pick<GmgnTrenchToken, "symbol" | "name" | "address">): void {
  logInfo(`${CANDIDATE_LOG_DIVIDER}`);
  logInfo(`CANDIDATE START | ${getTokenLabel(token)}`);
}

function logCandidateBlockEnd(
  token: Pick<GmgnTrenchToken, "symbol" | "name" | "address">,
  status: "PASSED" | "FAILED",
  stage: string,
  reasons: string[] = [],
): void {
  const reasonText = reasons.length > 0 ? ` | reasons=${reasons.join("; ")}` : "";
  logInfo(`CANDIDATE END | ${status} | ${getTokenLabel(token)} | stage=${stage}${reasonText}`);
  logInfo(`${CANDIDATE_LOG_DIVIDER}`);
}

function getExchangeTypeForFunding(funding: HeliusFundedByResponse | null): string | null {
  if (!funding) {
    return null;
  }

  const normalizedType = funding.funderType?.trim().toLowerCase();
  if (!normalizedType) {
    return null;
  }

  return normalizedType === "centralized exchange" ? funding.funderType : null;
}

async function resolveCreatorFundingChain(
  creatorFunding: HeliusFundedByResponse | null,
): Promise<{
  chain: HeliusFundedByResponse[];
  matchedExchangeType: string | null;
  matchedExchangeHop: number | null;
}> {
  if (!creatorFunding) {
    return {
      chain: [],
      matchedExchangeType: null,
      matchedExchangeHop: null,
    };
  }

  const match = getExchangeTypeForFunding(creatorFunding);
  if (!match) {
    return {
      chain: [creatorFunding],
      matchedExchangeType: null,
      matchedExchangeHop: null,
    };
  }

  return {
    chain: [creatorFunding],
    matchedExchangeType: match,
    matchedExchangeHop: 1,
  };
}

function shouldKeepFunding(candidate: CandidateResult): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { analysis } = candidate;

  if (!analysis.creatorFunding) {
    reasons.push("no creator funded-by record found");
  }

  if (config.filters.requireExchangeFunder && !analysis.matchedExchangeType) {
    reasons.push("creator funding source is not a centralized exchange");
  }

  if (analysis.devCreatedTokenCount === null) {
    reasons.push("dev created token count could not be verified");
  } else if (analysis.devCreatedTokenCount > config.filters.maxDevCreatedTokens) {
    reasons.push(`dev created token count is ${analysis.devCreatedTokenCount}`);
  }

  if (!analysis.firstTxFee) {
    reasons.push("first token transaction fee could not be verified");
  } else {
    reasons.push(...getFirstTxFilterReasons(analysis.firstTxFee));
  }

  return { keep: reasons.length === 0, reasons };
}

function getFirstTxFilterReasons(firstTxFee: TokenFirstTxFeeAnalysis): string[] {
  return [...getFirstTxFeeAndTipReasons(firstTxFee), ...getNativeTransferPatternReasons(firstTxFee)];
}

function getFirstTxFeeAndTipReasons(firstTxFee: TokenFirstTxFeeAnalysis): string[] {
  const reasons: string[] = [];
  const targetFeeDifferenceLamports = Math.round(config.filters.firstTxFeeDifferenceSol * LAMPORTS_PER_SOL);
  const firstTxFeeLamports = firstTxFee.firstTxFeeLamports;
  const totalFeeLamports = firstTxFee.totalFeeLamports;
  const priorityFeeLamports = firstTxFee.priorityFeeLamports;

  if (firstTxFeeLamports === null) {
    reasons.push("first token transaction fee is missing");
  } else if (
    firstTxFeeLamports < config.filters.minFirstTxFeeLamports ||
    firstTxFeeLamports > config.filters.maxFirstTxFeeLamports
  ) {
    reasons.push(`first token transaction fee is ${firstTxFeeLamports} lamports`);
  }

  if (priorityFeeLamports === null) {
    reasons.push("first token transaction priority fee could not be decoded");
  } else if (totalFeeLamports === null) {
    reasons.push("first token transaction total fee is missing");
  } else if (totalFeeLamports - priorityFeeLamports !== targetFeeDifferenceLamports) {
    reasons.push(`first token transaction fee difference is ${(totalFeeLamports - priorityFeeLamports) / LAMPORTS_PER_SOL} SOL`);
  }

  if (firstTxFee.tipFeeLamports === null) {
    reasons.push("first token transaction tip fee could not be calculated");
  } else if (firstTxFee.tipFeeLamports !== 0) {
    reasons.push(`first token transaction tip fee is ${firstTxFee.tipFeeSol} SOL`);
  }

  return reasons;
}

function getNativeTransferPatternReasons(firstTxFee: TokenFirstTxFeeAnalysis): string[] {
  const reasons: string[] = [];

  if (!firstTxFee.nativePatternMatched) {
    reasons.push(`first token transaction native transfer pattern failed with ${firstTxFee.nativeTransferCount} transfers`);
  }

  if (!firstTxFee.nativePatternAddress) {
    reasons.push("first token transaction pattern address is missing");
  }

  return reasons;
}

function summarizeCandidate(candidate: CandidateResult): string {
  const { token, analysis } = candidate;
  const fundingFrom = analysis.creatorFunding?.funder ?? "unknown";
  const fundingAt = analysis.creatorFunding?.timestamp ?? 0;
  const lag = analysis.fundingLagHours === null ? "n/a" : `${analysis.fundingLagHours.toFixed(2)}h`;
  const minFunding = analysis.minFundingSol === null ? "n/a" : `${analysis.minFundingSol.toFixed(3)} SOL`;
  const maxFunding = analysis.maxFundingSol === null ? "n/a" : `${analysis.maxFundingSol.toFixed(3)} SOL`;
  const fundingTime = fundingAt > 0 ? new Date(fundingAt * 1000).toISOString() : "unknown";
  const xCommunity = getXCommunityLink(token) ?? "unknown";
  const x = token.twitter && !isXCommunityUrl(token.twitter) ? token.twitter : "unknown";
  const exchangeLabel = analysis.matchedExchangeType ?? "unlabeled";
  const firstTxFee = analysis.firstTxFee;

  return [
    `${token.symbol} (${token.address})`,
    `creator=${token.creator}`,
    `telegram=${token.telegram}`,
    `x=${x}`,
    `website=${token.website}`,
    `x_community=${xCommunity}`,
    `creator_funded_by=${fundingFrom}`,
    `creator_funding_time=${fundingTime}`,
    `creator_funder_name=${analysis.creatorFunding?.funderName ?? "unknown"}`,
    `creator_funder_type=${analysis.creatorFunding?.funderType ?? "unknown"}`,
    `exchange_match=${exchangeLabel}`,
    `dev_created_tokens=${analysis.devCreatedTokenCount ?? "unknown"}`,
    `first_tx_signature=${firstTxFee?.signature ?? "unknown"}`,
    `first_tx_fee_lamports=${firstTxFee?.firstTxFeeLamports ?? "unknown"}`,
    `priority_fee_sol=${firstTxFee?.priorityFeeSol ?? "unknown"}`,
    `total_fee_sol=${firstTxFee?.totalFeeSol ?? "unknown"}`,
    `fee_difference_sol=${firstTxFee?.totalMinusPriorityFeeSol ?? "unknown"}`,
    `tip_fee_sol=${firstTxFee?.tipFeeSol ?? "unknown"}`,
    `native_transfer_count=${firstTxFee?.nativeTransferCount ?? "unknown"}`,
    `pattern_address=${firstTxFee?.nativePatternAddress ?? "unknown"}`,
    `pattern_next_tx_signature=${firstTxFee?.patternNextTxSignature ?? "unknown"}`,
    `pattern_next_tx_time=${firstTxFee?.patternNextTxTimestamp ? new Date(firstTxFee.patternNextTxTimestamp * 1000).toISOString() : "unknown"}`,
    `pattern_next_tx_fee_payer=${firstTxFee?.patternNextTxFeePayer ?? "unknown"}`,
    `pattern_next_tx_program_count=${firstTxFee?.patternNextTxProgramCount ?? "unknown"}`,
    `funding_lag=${lag}`,
    `min_funding=${minFunding}`,
    `max_funding=${maxFunding}`,
    `fresh_wallet=${analysis.isFreshWallet}`,
    `non_native_balance_count=${analysis.nonNativeBalanceCount}`,
  ].join(" | ");
}

export async function processNewTokenEvent(event: PumpPortalNewTokenEvent): Promise<void> {
  const eventMint = typeof event.mint === "string" ? event.mint : "unknown";
  logDebug(`Received PumpPortal launch event for ${eventMint}.`);

  const normalized = await normalizePumpPortalToken(event);
  if ("skipped" in normalized) {
    logDebug(`Skipping ${eventMint}: ${normalized.reason}.`);
    return;
  }

  logDebug(
    `Metadata fetched for ${normalized.token.address}: valid=${normalized.metadataValid} name=${normalized.token.name || "missing"} symbol=${normalized.token.symbol || "missing"} image=${normalized.metadata?.image ? "yes" : "no"}.`,
  );

  if (!normalized.metadataValid) {
    if (config.runtime.debugPipeline) {
      const uri = typeof event.uri === "string" ? event.uri : "missing-uri";
      throw new Error(
        `Invalid token metadata for ${normalized.token.address}: missing ${normalized.missingMetadataFields.join(", ")} (uri=${uri})`,
      );
    }

    return;
  }

  const token = normalized.token;
  logDebug(`Starting Helius checks for ${getTokenLabel(token)}.`);
  const { candidate, reasons } = await buildCandidate(token);
  if (!candidate) {
    logDebug(`Exchange/dev-count filters rejected ${getTokenLabel(token)}: ${reasons.join(", ")}.`);
    return;
  }

  logSignal(`${getTokenLabel(token)} passed all Helius, dev-count, and pattern-address filters`);
  logDebug(`All filters passed for ${getTokenLabel(token)}.`);
  logInfo(`All filters passed for ${getTokenLabel(token)}.`);
  const enrichedCandidate = await enrichSuccessfulCandidateSocials(candidate);
  logFound(getTokenLabel(enrichedCandidate.token));
  console.log(summarizeCandidate(enrichedCandidate));
  await recordFirstTxPattern(enrichedCandidate);
  await maybeExecuteBuys([enrichedCandidate]);
  logCandidateBlockEnd(enrichedCandidate.token, "PASSED", "all_filters");
}

async function enrichSuccessfulCandidateSocials(candidate: CandidateResult): Promise<CandidateResult> {
  const tokenBefore = candidate.token;
  const enrichedToken = await enrichTokenWithGmgnSocials(tokenBefore);
  const gainedSocial =
    (!tokenBefore.telegram && enrichedToken.telegram) ||
    (!tokenBefore.twitter && enrichedToken.twitter) ||
    (!tokenBefore.website && enrichedToken.website);

  if (gainedSocial) {
    logInfo(
      `${getTokenLabel(enrichedToken)} socials enriched: telegram=${enrichedToken.telegram || "unknown"}, twitter=${enrichedToken.twitter || "unknown"}, website=${enrichedToken.website || "unknown"}`,
    );
  }

  return {
    ...candidate,
    token: enrichedToken,
  };
}

async function recordFirstTxPattern(candidate: CandidateResult): Promise<void> {
  const patternAddress = candidate.analysis.firstTxFee?.nativePatternAddress;
  const signature = candidate.analysis.firstTxFee?.signature;
  if (!patternAddress || !signature) {
    return;
  }

  const state = await FirstTxPatternState.create();
  const matches = state.getMatches(patternAddress).filter((match) => match.tokenMint !== candidate.token.address);
  if (matches.length > 0) {
    logInfo(
      `Pattern address ${patternAddress} was already seen on ${matches.length} passed token(s): ${matches
        .map((match) => `${match.symbol}:${match.tokenMint}`)
        .join(", ")}`,
    );
  }

  await state.record(patternAddress, candidate.token.address, candidate.token.symbol || candidate.token.name || "unknown", signature);
}

async function getPreviousPatternMatches(candidate: CandidateResult): Promise<Array<{ tokenMint: string; symbol: string; seenAt: string; signature: string }>> {
  const patternAddress = candidate.analysis.firstTxFee?.nativePatternAddress;
  if (!patternAddress) {
    return [];
  }

  const state = await FirstTxPatternState.create();
  return state.getMatches(patternAddress).filter((match) => match.tokenMint !== candidate.token.address);
}

async function buildCandidate(token: GmgnTrenchToken): Promise<{ candidate: CandidateResult | null; reasons: string[] }> {
  let creatorFunding;

  try {
    creatorFunding = await fetchFundedBy(token.creator);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidate: null,
      reasons: [`creator funded-by lookup failed: ${message}`],
    };
  }

  const fundingChain = await resolveCreatorFundingChain(creatorFunding);
  if (config.filters.requireExchangeFunder && !fundingChain.matchedExchangeType) {
    return {
      candidate: null,
      reasons: ["creator funding source is not a centralized exchange"],
    };
  }

  const fundingAmount = creatorFunding?.symbol === "SOL" ? creatorFunding.amount : null;
  if (fundingAmount === null) {
    return {
      candidate: null,
      reasons: ["creator funding amount is missing or not SOL"],
    };
  }

  if (fundingAmount < config.filters.minFundingSol || fundingAmount > config.filters.maxFundingSol) {
    return {
      candidate: null,
      reasons: [`creator funding amount is ${fundingAmount} SOL`],
    };
  }

  const fundingLagHours = creatorFunding ? (token.created_timestamp - creatorFunding.timestamp) / 3600 : null;
  if (fundingLagHours === null) {
    return {
      candidate: null,
      reasons: ["creator funding time could not be calculated"],
    };
  }

  if (
    fundingLagHours < config.filters.minFundingHoursBeforeCreation ||
    fundingLagHours > config.filters.maxFundingHoursBeforeCreation
  ) {
    return {
      candidate: null,
      reasons: [`creator funding lag is ${fundingLagHours.toFixed(4)} hours`],
    };
  }

  let firstTxFee: TokenFirstTxFeeAnalysis | null = null;
  let firstTxReason: string | null = null;
  let devCreatedTokenCount = 0;
  try {
    const firstTxResult = await fetchDevCreateTransactionFeeAnalysis(token.creator, token.address);
    firstTxFee = firstTxResult.analysis;
    firstTxReason = firstTxResult.reason;
    devCreatedTokenCount = firstTxResult.devCreatedTokenCount;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidate: null,
      reasons: [`dev CREATE Helius lookup failed: ${message}`],
    };
  }

  if (!firstTxFee) {
    return {
      candidate: null,
      reasons: [`first token transaction fee could not be verified: ${firstTxReason ?? "unknown reason"}`],
    };
  }

  if (devCreatedTokenCount > config.filters.maxDevCreatedTokens) {
    return {
      candidate: null,
      reasons: [`dev created token count is ${devCreatedTokenCount}`],
    };
  }

  const nativePatternReasons = getNativeTransferPatternReasons(firstTxFee);
  if (nativePatternReasons.length > 0) {
    return {
      candidate: null,
      reasons: nativePatternReasons,
    };
  }

  logCandidateBlockStart(token);
  logSignal(`${getTokenLabel(token)} passed native-transfer pattern filter`);
  logInfo(
    `${getTokenLabel(token)} native pattern passed: transfers=${firstTxFee.nativeTransferCount}, pattern_address=${firstTxFee.nativePatternAddress ?? "unknown"}, first_tx=${firstTxFee.signature}`,
  );

  const nextPatternTxReasons = await applyNextPatternTransactionFilters(token, firstTxFee);
  if (nextPatternTxReasons.length > 0) {
    logInfo(`${getTokenLabel(token)} rejected after native pattern pass at next-pattern tx filter: ${nextPatternTxReasons.join(", ")}`);
    logCandidateBlockEnd(token, "FAILED", "next_pattern_address_tx", nextPatternTxReasons);
    return {
      candidate: null,
      reasons: nextPatternTxReasons,
    };
  }

  logInfo(
    `${getTokenLabel(token)} next pattern-address tx passed: signature=${firstTxFee.patternNextTxSignature}, time=${firstTxFee.patternNextTxTimestamp ? new Date(firstTxFee.patternNextTxTimestamp * 1000).toISOString() : "unknown"}, fee_payer=${firstTxFee.patternNextTxFeePayer}, programs=${firstTxFee.patternNextTxProgramCount}`,
  );

  const feeAndTipReasons = getFirstTxFeeAndTipReasons(firstTxFee);
  if (feeAndTipReasons.length > 0) {
    logInfo(`${getTokenLabel(token)} rejected after native pattern pass at fee/tip filter: ${feeAndTipReasons.join(", ")}`);
    logCandidateBlockEnd(token, "FAILED", "fee_tip", feeAndTipReasons);
    return {
      candidate: null,
      reasons: feeAndTipReasons,
    };
  }

  logSignal(`${getTokenLabel(token)} passed fee/tip filters; checking dev count`);
  logInfo(
    `${getTokenLabel(token)} fee/tip passed: fee=${firstTxFee.firstTxFeeLamports ?? "unknown"} lamports, priority=${firstTxFee.priorityFeeSol ?? "unknown"} SOL, fee_difference=${firstTxFee.totalMinusPriorityFeeSol ?? "unknown"} SOL, tip=${firstTxFee.tipFeeSol ?? "unknown"} SOL`,
  );

  const analysis = analyzeCreatorFunding(
    token,
    null,
    creatorFunding,
    null,
    fundingChain.chain,
    fundingChain.matchedExchangeType,
    fundingChain.matchedExchangeHop,
    devCreatedTokenCount,
    firstTxFee,
  );
  const candidate: CandidateResult = { token, analysis, reasons: [] };
  logInfo(`${getTokenLabel(token)} checking pattern-address uniqueness: pattern_address=${firstTxFee.nativePatternAddress}`);
  const previousPatternMatches = await getPreviousPatternMatches(candidate);
  if (previousPatternMatches.length > 0) {
    logInfo(
      `${getTokenLabel(token)} rejected at pattern-address uniqueness: pattern_address=${firstTxFee.nativePatternAddress} already seen on ${previousPatternMatches.length} successful token(s)`,
    );
    logCandidateBlockEnd(token, "FAILED", "pattern_address_uniqueness", [
      `pattern address ${firstTxFee.nativePatternAddress} already seen on ${previousPatternMatches.length} successful token(s)`,
    ]);
    return {
      candidate: null,
      reasons: [
        `pattern address ${firstTxFee.nativePatternAddress} already seen on ${previousPatternMatches.length} successful token(s)`,
      ],
    };
  }

  logInfo(`${getTokenLabel(token)} pattern-address uniqueness passed: pattern_address=${firstTxFee.nativePatternAddress}, previous_successful_matches=0`);

  logDebug(
    `Funding analysis passed for ${getTokenLabel(token)}: lag=${analysis.fundingLagHours ?? "n/a"}h min=${analysis.minFundingSol ?? "n/a"} max=${analysis.maxFundingSol ?? "n/a"} exchange=${analysis.matchedExchangeType ?? "none"} devCreatedTokens=${analysis.devCreatedTokenCount ?? "unknown"} firstTxFee=${analysis.firstTxFee?.firstTxFeeLamports ?? "unknown"} feeDiff=${analysis.firstTxFee?.totalMinusPriorityFeeSol ?? "unknown"} patternAddress=${analysis.firstTxFee?.nativePatternAddress ?? "unknown"}.`,
  );

  return {
    candidate,
    reasons: [],
  };
}

async function applyNextPatternTransactionFilters(token: GmgnTrenchToken, firstTxFee: TokenFirstTxFeeAnalysis): Promise<string[]> {
  const patternAddress = firstTxFee.nativePatternAddress;
  if (!patternAddress) {
    return ["pattern address is missing"];
  }

  let nextTxResult;
  try {
    nextTxResult = await fetchNextPatternAddressTransaction(patternAddress, firstTxFee.signature, token.address, token.creator);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`next pattern-address transaction lookup failed: ${message}`];
  }

  const nextTx = nextTxResult.transaction;
  if (!nextTx?.signature) {
    return ["next pattern-address buy transaction was not found in the post-create window"];
  }

  firstTxFee.patternNextTxSignature = nextTx.signature;
  firstTxFee.patternNextTxTimestamp = nextTx.timestamp ?? null;
  firstTxFee.patternNextTxFeePayer = nextTx.feePayer ?? null;
  firstTxFee.patternNextTxProgramCount = nextTxResult.programCount;

  const reasons: string[] = [];
  if (nextTxResult.programCount !== 5 && nextTxResult.programCount !== 7) {
    reasons.push(`next pattern-address transaction program count is ${nextTxResult.programCount ?? "unknown"}, required=5 or 7`);
  }

  if (!nextTx.feePayer) {
    reasons.push("next pattern-address transaction fee payer is missing");
    return reasons;
  }

  if (nextTx.feePayer === token.creator) {
    reasons.push("next pattern-address transaction fee payer is the token creator");
  }

  const feePayerReceivesToken = nextTx.tokenTransfers?.some(
    (transfer) => transfer.mint === token.address && transfer.toUserAccount === nextTx.feePayer,
  );
  if (!feePayerReceivesToken) {
    reasons.push("next pattern-address transaction is not a fee-payer buy for this token");
  }

  return reasons;
}

async function maybeExecuteBuys(results: CandidateResult[]): Promise<void> {
  const buyState = await BuyState.create();
  const buyable = results.filter((candidate) => !buyState.has(candidate.token.address));

  if (buyable.length === 0) {
    logDebug("All qualified tokens were already present in the buy state file.");
    logInfo("No new buy candidates after removing already-bought tokens.");
    return;
  }

  const selected = buyable.slice(0, config.jupiter.maxBuysPerCycle);
  logDebug(`Selected ${selected.length} token(s) for buy evaluation out of ${results.length} qualified token(s).`);

  if (!config.jupiter.enableLiveBuy) {
    logInfo(
      `Live buy disabled. ${selected.length} token(s) qualified for buy. Set ENABLE_LIVE_BUY=true after reviewing wallet + size settings.`,
    );
    return;
  }

  if (!canExecuteLiveBuy()) {
    logDebug("Live buy gate failed because the Jupiter wallet configuration is incomplete.");
    logWarn("Live buy is enabled but Jupiter buyer wallet is not configured correctly.");
    return;
  }

  for (const candidate of selected) {
    try {
      logDebug(`Creating Jupiter Ultra order for ${getTokenLabel(candidate.token)}.`);
      logInfo(`Submitting Jupiter Ultra buy for ${candidate.token.symbol} ${candidate.token.address}...`);
      const order = await createUltraOrder(candidate.token.address);
      logDebug(`Executing signed Jupiter Ultra order for ${getTokenLabel(candidate.token)}.`);
      const execution = await executeUltraOrder(order);
      await buyState.markBought(candidate.token.address, execution.signature ?? null);
      logSuccess(
        `Bought ${candidate.token.symbol} ${candidate.token.address} via Jupiter Ultra. Signature: ${execution.signature ?? "pending"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug(`Buy execution failed for ${getTokenLabel(candidate.token)}: ${message}`);
      logWarn(`Jupiter buy failed for ${candidate.token.symbol} ${candidate.token.address}: ${message}`);
    }
  }
}
