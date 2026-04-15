import { fetchFundedBy, fetchWalletBalances } from "./clients/helius.js";
import { canExecuteLiveBuy, createUltraOrder, executeUltraOrder } from "./clients/jupiter.js";
import { enrichTokenWithGmgnSocials } from "./clients/gmgn.js";
import { normalizePumpPortalToken } from "./clients/pumpportal.js";
import { config } from "./config.js";
import { analyzeCreatorFunding, getXCommunityLink, hasTelegramLink } from "./filters.js";
import { logDebug, logFound, logInfo, logSignal, logSuccess, logWarn } from "./logger.js";
import { BuyState } from "./state.js";
import type { CandidateResult, GmgnTrenchToken, HeliusFundedByResponse, PumpPortalNewTokenEvent } from "./types.js";

function getTokenLabel(token: Pick<GmgnTrenchToken, "symbol" | "name" | "address">): string {
  return `${token.symbol || token.name || "unknown"} ${token.address}`;
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
  const chain: HeliusFundedByResponse[] = [];
  const visited = new Set<string>();
  let current = creatorFunding;

  while (current && chain.length < config.filters.maxFunderHops) {
    chain.push(current);

    const match = getExchangeTypeForFunding(current);
    if (match) {
      return {
        chain,
        matchedExchangeType: match,
        matchedExchangeHop: chain.length,
      };
    }

    if (!current.funder || visited.has(current.funder)) {
      break;
    }

    visited.add(current.funder);
    current = await fetchFundedBy(current.funder);
  }

  return {
    chain,
    matchedExchangeType: null,
    matchedExchangeHop: null,
  };
}

function shouldKeepSocial(token: GmgnTrenchToken): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (config.filters.requireTelegram && !hasTelegramLink(token.telegram)) {
    reasons.push("missing Telegram channel/group");
  }

  if (config.filters.requireXCommunity && !getXCommunityLink(token)) {
    reasons.push("missing X community link");
  }

  return { keep: reasons.length === 0, reasons };
}

function shouldKeepFunding(candidate: CandidateResult): { keep: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { analysis } = candidate;

  if (!analysis.creatorFunding) {
    reasons.push("no creator funded-by record found");
  }

  if (analysis.fundingLagHours !== null) {
    if (analysis.fundingLagHours < config.filters.minFundingHoursBeforeCreation) {
      reasons.push("funding too close to creation");
    }

    if (analysis.fundingLagHours > config.filters.maxFundingHoursBeforeCreation) {
      reasons.push("funding too old before creation");
    }
  }

  if (analysis.minFundingSol !== null && analysis.minFundingSol < config.filters.minFundingSol) {
    reasons.push("minimum inbound funding below threshold");
  }

  if (analysis.maxFundingSol !== null && analysis.maxFundingSol > config.filters.maxFundingSol) {
    reasons.push("maximum inbound funding above threshold");
  }

  if (analysis.previousTokenTxCount > config.filters.maxPreviousTokenTxCount) {
    reasons.push("creator wallet has non-native token balance history");
  }

  if (config.filters.requireExchangeFunder && !analysis.matchedExchangeType) {
    reasons.push("creator funding source is not a centralized exchange");
  }

  if (!analysis.isFreshWallet) {
    reasons.push("creator wallet is not fresh");
  }

  return { keep: reasons.length === 0, reasons };
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
  const tokenFundingFrom = analysis.tokenFunding?.funder ?? "unknown";
  const tokenFundingTime = analysis.tokenFunding?.timestamp ? new Date(analysis.tokenFunding.timestamp * 1000).toISOString() : "unknown";
  const exchangeLabel = analysis.matchedExchangeType ?? "unlabeled";
  const exchangeHop = analysis.matchedExchangeHop ?? 0;
  const creatorFundingPath =
    analysis.creatorFundingChain.length > 0
      ? analysis.creatorFundingChain.map((entry) => entry.funderName ?? entry.funderType ?? entry.funder).join(" -> ")
      : "unknown";

  return [
    `${token.symbol} (${token.address})`,
    `creator=${token.creator}`,
    `telegram=${token.telegram}`,
    `x_community=${xCommunity}`,
    `creator_funded_by=${fundingFrom}`,
    `creator_funding_time=${fundingTime}`,
    `creator_funder_name=${analysis.creatorFunding?.funderName ?? "unknown"}`,
    `creator_funder_type=${analysis.creatorFunding?.funderType ?? "unknown"}`,
    `exchange_match=${exchangeLabel}`,
    `exchange_hop=${exchangeHop}`,
    `creator_funding_path=${creatorFundingPath}`,
    `token_funded_by=${tokenFundingFrom}`,
    `token_funding_time=${tokenFundingTime}`,
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
  if (!normalized) {
    logDebug(`Skipping ${eventMint}: missing mint or creator in launch payload.`);
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

  logDebug(`Enriching socials from GMGN fallback for ${getTokenLabel(normalized.token)}.`);
  const token = await enrichTokenWithGmgnSocials(normalized.token);
  logDebug(
    `Social sources for ${getTokenLabel(token)}: telegram=${token.telegram ? "yes" : "no"} twitter=${token.twitter ? "yes" : "no"} website=${token.website ? "yes" : "no"}.`,
  );

  const socialDecision = shouldKeepSocial(token);
  if (!socialDecision.keep) {
    logDebug(`Social filter rejected ${getTokenLabel(token)}: ${socialDecision.reasons.join(", ")}.`);
    return;
  }

  logSignal(`${getTokenLabel(token)} passed socials, checking Helius`);
  logDebug(`Starting Helius checks for ${getTokenLabel(token)}.`);
  const { candidate, reasons } = await buildCandidate(token);
  if (!candidate) {
    logInfo(`Helius filters rejected ${getTokenLabel(token)}: ${reasons.join(", ")}.`);
    logDebug(`Helius filters rejected ${getTokenLabel(token)}.`);
    return;
  }

  logDebug(`Helius filters passed for ${getTokenLabel(token)}.`);
  logInfo(`Helius filters passed for ${getTokenLabel(token)}.`);
  logFound(getTokenLabel(token));
  console.log(summarizeCandidate(candidate));
  await maybeExecuteBuys([candidate]);
}

async function buildCandidate(token: GmgnTrenchToken): Promise<{ candidate: CandidateResult | null; reasons: string[] }> {
  const [creatorBalances, creatorFunding, tokenFunding] = await Promise.all([
    fetchWalletBalances(token.creator),
    fetchFundedBy(token.creator),
    fetchFundedBy(token.address),
  ]);
  const fundingChain = await resolveCreatorFundingChain(creatorFunding);
  const analysis = analyzeCreatorFunding(
    token,
    creatorBalances,
    creatorFunding,
    tokenFunding,
    fundingChain.chain,
    fundingChain.matchedExchangeType,
    fundingChain.matchedExchangeHop,
  );
  const candidate: CandidateResult = { token, analysis, reasons: [] };
  const fundingDecision = shouldKeepFunding(candidate);
  if (!fundingDecision.keep) {
    logDebug(`Funding analysis for ${getTokenLabel(token)}: ${fundingDecision.reasons.join(", ")}.`);
  } else {
    logDebug(
      `Funding analysis passed for ${getTokenLabel(token)}: lag=${analysis.fundingLagHours ?? "n/a"}h min=${analysis.minFundingSol ?? "n/a"} max=${analysis.maxFundingSol ?? "n/a"} exchange=${analysis.matchedExchangeType ?? "none"} fresh=${analysis.isFreshWallet}.`,
    );
  }

  if (!fundingDecision.keep) {
    return {
      candidate: null,
      reasons: fundingDecision.reasons,
    };
  }

  return {
    candidate,
    reasons: [],
  };
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
