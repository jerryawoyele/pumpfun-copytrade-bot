export interface GmgnTrenchToken {
  address: string;
  symbol: string;
  name: string;
  creator: string;
  created_timestamp: number;
  launchpad_platform: string;
  liquidity: number;
  usd_market_cap: number;
  telegram: string;
  twitter: string;
  website: string;
  holder_count: number;
  smart_degen_count: number;
  renowned_count: number;
  fund_from: string;
  fund_from_ts: number;
  has_at_least_one_social: boolean;
}

export interface PumpPortalNewTokenEvent {
  mint?: string;
  name?: string;
  symbol?: string;
  traderPublicKey?: string;
  creator?: string;
  uri?: string;
  timestamp?: number;
  marketCapSol?: number;
  bondingCurveKey?: string;
  [key: string]: unknown;
}

export interface PumpTokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  extensions?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NormalizedPumpPortalTokenResult {
  token: GmgnTrenchToken;
  metadata: PumpTokenMetadata | null;
  metadataValid: boolean;
  missingMetadataFields: string[];
}

export interface SkippedPumpPortalTokenResult {
  skipped: true;
  reason: string;
}

export type PumpPortalTokenNormalizationResult = NormalizedPumpPortalTokenResult | SkippedPumpPortalTokenResult;

export interface HeliusWalletBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  usdValue: number | null;
  pricePerToken: number | null;
  logoUri?: string;
  tokenProgram: string;
}

export interface HeliusBalancesResponse {
  balances: HeliusWalletBalance[];
  totalUsdValue: number;
  pagination: {
    page: number;
    limit: number;
    hasMore: boolean;
  };
}

export interface HeliusFundedByResponse {
  funder: string;
  funderName: string | null;
  funderType: string | null;
  mint: string;
  symbol: string;
  amount: number;
  amountRaw: string;
  decimals: number;
  signature: string;
  timestamp: number;
  date: string;
  slot: number;
  explorerUrl: string;
}

export interface HeliusEnhancedTransaction {
  fee?: number;
  feePayer?: string;
  signature?: string;
  slot?: number;
  timestamp?: number;
  type?: string;
  source?: string;
  tokenTransfers?: Array<{
    fromTokenAccount?: string;
    toTokenAccount?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
    mint?: string;
    tokenStandard?: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  instructions?: Array<{
    programId?: string;
    data?: string;
  }>;
  [key: string]: unknown;
}

export interface TokenFirstTxFeeAnalysis {
  signature: string;
  feePayer: string | null;
  source: string | null;
  type: string | null;
  timestamp: number | null;
  firstTxFeeLamports: number | null;
  computeUnitLimit: number | null;
  computeUnitPriceMicroLamports: number | null;
  priorityFeeLamports: number | null;
  priorityFeeAtConsumedUnitsLamports: number | null;
  computeUnitsConsumed: number | null;
  totalFeeLamports: number | null;
  priorityFeeSol: number | null;
  priorityFeeAtConsumedUnitsSol: number | null;
  totalFeeSol: number | null;
  totalMinusPriorityFeeSol: number | null;
  tipFeeLamports: number | null;
  tipFeeSol: number | null;
  nativeTransferCount: number;
  nativePatternMatched: boolean;
  nativePatternAddress: string | null;
}

export interface CreatorFundingAnalysis {
  creator: string;
  creatorFunding: HeliusFundedByResponse | null;
  tokenFunding: HeliusFundedByResponse | null;
  creatorFundingChain: HeliusFundedByResponse[];
  devCreatedTokenCount: number | null;
  firstTxFee: TokenFirstTxFeeAnalysis | null;
  fundingLagHours: number | null;
  minFundingSol: number | null;
  maxFundingSol: number | null;
  previousTokenTxCount: number;
  isFreshWallet: boolean;
  nonNativeBalanceCount: number;
  matchedExchangeType: string | null;
  matchedExchangeHop: number | null;
}

export interface CandidateResult {
  token: GmgnTrenchToken;
  analysis: CreatorFundingAnalysis;
  reasons: string[];
}

export interface JupiterOrderResponse {
  transaction: string;
  requestId: string;
}

export interface JupiterExecuteResponse {
  signature?: string;
  status?: string;
  error?: string;
  [key: string]: unknown;
}

export interface BuyExecutionResult {
  tokenMint: string;
  signature: string | null;
  requestId: string | null;
  status: string;
}
