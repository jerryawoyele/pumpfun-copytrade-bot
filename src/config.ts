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
    reconnectDelayMs: getNumber("PUMPPORTAL_RECONNECT_DELAY_MS", 3000),
    pingIntervalMs: getNumber("PUMPPORTAL_PING_INTERVAL_MS", 15000),
    pongTimeoutMs: getNumber("PUMPPORTAL_PONG_TIMEOUT_MS", 10000),
  },
  helius: {
    apiKey: requireString("HELIUS_API_KEY"),
    historyLimit: getNumber("HELIUS_TX_HISTORY_LIMIT", 100),
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
    minFundingSol: getNumber("MIN_FUNDING_SOL", 0.2),
    maxFundingSol: getNumber("MAX_FUNDING_SOL", 25),
    minFundingHoursBeforeCreation: getNumber("MIN_FUNDING_HOURS_BEFORE_CREATION", 0),
    maxFundingHoursBeforeCreation: getNumber("MAX_FUNDING_HOURS_BEFORE_CREATION", 72),
    maxPreviousTokenTxCount: getNumber("MAX_PREVIOUS_TOKEN_TX_COUNT", 0),
    requireExchangeFunder: getBoolean("REQUIRE_EXCHANGE_FUNDER", true),
    maxFunderHops: getNumber("MAX_FUNDER_HOPS", 3),
  },
  runtime: {
    runWindowStart: getString("RUN_WINDOW_START", "08:00"),
    runWindowEnd: getString("RUN_WINDOW_END", "23:00"),
    timezone: getString("RUN_TIMEZONE", "Africa/Lagos"),
    logLevel: getString("LOG_LEVEL", "info"),
  },
} as const;
