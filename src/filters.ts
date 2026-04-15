import type {
  CreatorFundingAnalysis,
  GmgnTrenchToken,
  HeliusBalancesResponse,
  HeliusFundedByResponse,
  HeliusWalletBalance,
} from "./types.js";

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111111";

export function isXCommunityUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.includes("x.com/i/communities/") || normalized.includes("twitter.com/i/communities/");
}

export function hasTelegramLink(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("https://t.me/") || normalized.startsWith("http://t.me/");
}

export function getXCommunityLink(token: Pick<GmgnTrenchToken, "twitter" | "website">): string | null {
  if (isXCommunityUrl(token.twitter)) {
    return normalizePossiblyPartialUrl(token.twitter);
  }

  if (isXCommunityUrl(token.website)) {
    return normalizePossiblyPartialUrl(token.website);
  }

  return null;
}

function normalizePossiblyPartialUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  if (trimmed.startsWith("x.com/") || trimmed.startsWith("twitter.com/")) {
    return `https://${trimmed}`;
  }

  if (trimmed.startsWith("i/communities/")) {
    return `https://x.com/${trimmed}`;
  }

  return trimmed;
}

function getRelevantTokenBalances(
  balances: HeliusWalletBalance[],
  tokenMint: string,
): HeliusWalletBalance[] {
  return balances.filter((balance) => balance.mint !== NATIVE_SOL_MINT && balance.mint !== tokenMint && balance.balance > 0);
}

export function analyzeCreatorFunding(
  token: GmgnTrenchToken,
  creatorBalances: HeliusBalancesResponse | null,
  creatorFunding: HeliusFundedByResponse | null,
  tokenFunding: HeliusFundedByResponse | null,
  creatorFundingChain: HeliusFundedByResponse[],
  matchedExchangeKeyword: string | null,
  matchedExchangeHop: number | null,
): CreatorFundingAnalysis {
  const creatorFundingAmount = creatorFunding?.symbol === "SOL" ? creatorFunding.amount : null;
  const tokenFundingAmount = tokenFunding?.symbol === "SOL" ? tokenFunding.amount : null;
  const fundingAmounts = [creatorFundingAmount, tokenFundingAmount].filter((value): value is number => value !== null);
  const relevantTokenBalances = getRelevantTokenBalances(creatorBalances?.balances ?? [], token.address);

  return {
    creator: token.creator,
    creatorFunding,
    tokenFunding,
    creatorFundingChain,
    fundingLagHours: creatorFunding ? (token.created_timestamp - creatorFunding.timestamp) / 3600 : null,
    minFundingSol: fundingAmounts.length > 0 ? Math.min(...fundingAmounts) : null,
    maxFundingSol: fundingAmounts.length > 0 ? Math.max(...fundingAmounts) : null,
    previousTokenTxCount: relevantTokenBalances.length,
    isFreshWallet: relevantTokenBalances.length === 0,
    nonNativeBalanceCount: relevantTokenBalances.length,
    matchedExchangeType: matchedExchangeKeyword,
    matchedExchangeHop,
  };
}
