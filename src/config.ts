import { config as loadEnv } from "dotenv";

loadEnv();

function requireString(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function getNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
}

function getBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["true", "1", "yes"].includes(raw)) {
    return true;
  }

  if (["false", "0", "no"].includes(raw)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean.`);
}

export const config = {
  pumpPortal: {
    wsUrl: getString("PUMPPORTAL_WS_URL", "wss://pumpportal.fun/api/data"),
    reconnectDelayMs: getNumber("PUMPPORTAL_RECONNECT_DELAY_MS", 2000),
    pingIntervalMs: getNumber("PUMPPORTAL_PING_INTERVAL_MS", 15000),
    pongTimeoutMs: getNumber("PUMPPORTAL_PONG_TIMEOUT_MS", 10000),
    heartbeatResetMs: getNumber("PUMPPORTAL_HEARTBEAT_RESET_MS", 300000),
    metadataFetchRetries: getNumber("PUMPPORTAL_METADATA_FETCH_RETRIES", 3),
    metadataRetryDelayMs: getNumber("PUMPPORTAL_METADATA_RETRY_DELAY_MS", 250),
  },
  helius: {
    apiKey: requireString("HELIUS_API_KEY"),
    historyLimit: getNumber("HELIUS_TX_HISTORY_LIMIT", 100),
    minRequestIntervalMs: getNumber("HELIUS_MIN_REQUEST_INTERVAL_MS", 350),
    rateLimitBackoffMs: getNumber("HELIUS_RATE_LIMIT_BACKOFF_MS", 5000),
    devCreateFetchRetries: getNumber("HELIUS_DEV_CREATE_FETCH_RETRIES", 10),
    devCreateRetryDelayMs: getNumber("HELIUS_DEV_CREATE_RETRY_DELAY_MS", 1000),
  },
  jupiter: {
    apiKey: getString("JUP_API_KEY", ""),
    privateKeyBase58: getString("SOLANA_PRIVATE_KEY_B58", ""),
    enableLiveBuy: getBoolean("ENABLE_LIVE_BUY", false),
    buyAmountSol: getNumber("BUY_AMOUNT_SOL", 0.05),
    maxBuysPerCycle: getNumber("MAX_BUYS_PER_CYCLE", 1),
    inputMint: getString("BUY_INPUT_MINT", "So11111111111111111111111111111111111111112"),
    buyStateFile: getString("BUY_STATE_FILE", ".state/bought-tokens.json"),
    broadcastFeeType: getString("JUP_BROADCAST_FEE_TYPE", "exactFee"),
    priorityFeeLamports: getNumber("JUP_PRIORITY_FEE_LAMPORTS", 12000),
    jitoTipLamports: getNumber("JUP_JITO_TIP_LAMPORTS", 0),
  },
  filters: {
    requireTelegram: getBoolean("REQUIRE_TELEGRAM", true),
    requireXCommunity: getBoolean("REQUIRE_X_COMMUNITY", true),
    maxDevCreatedTokens: getNumber("MAX_DEV_CREATED_TOKENS", 9),
    minFirstTxFeeLamports: getNumber("MIN_FIRST_TX_FEE_LAMPORTS", 100000),
    maxFirstTxFeeLamports: getNumber("MAX_FIRST_TX_FEE_LAMPORTS", 1000000),
    firstTxFeeDifferenceSol: getNumber("FIRST_TX_FEE_DIFFERENCE_SOL", 0.00001),
    firstTxPatternStateFile: getString("FIRST_TX_PATTERN_STATE_FILE", ".state/first-tx-pattern-addresses.json"),
    minFundingSol: getNumber("MIN_FUNDING_SOL", 0.2),
    maxFundingSol: getNumber("MAX_FUNDING_SOL", 25),
    minFundingHoursBeforeCreation: getNumber("MIN_FUNDING_HOURS_BEFORE_CREATION", 0),
    maxFundingHoursBeforeCreation: getNumber("MAX_FUNDING_HOURS_BEFORE_CREATION", 72),
    requireExchangeFunder: getBoolean("REQUIRE_EXCHANGE_FUNDER", true),
  },
  runtime: {
    runWindowStart: getString("RUN_WINDOW_START", "08:00"),
    runWindowEnd: getString("RUN_WINDOW_END", "23:00"),
    timezone: getString("RUN_TIMEZONE", "Africa/Lagos"),
    logLevel: getString("LOG_LEVEL", "info"),
    debugPipeline: getBoolean("DEBUG_PIPELINE", false),
  },
} as const;
