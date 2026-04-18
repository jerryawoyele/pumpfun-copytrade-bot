import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { config } from "../config.js";
import { logInfo } from "../logger.js";
import type {
  GmgnTrenchToken,
  NormalizedPumpPortalTokenResult,
  PumpPortalTokenNormalizationResult,
  PumpPortalNewTokenEvent,
  PumpTokenMetadata,
} from "../types.js";

function normalizeUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getMetadataField(metadata: PumpTokenMetadata, key: "website" | "twitter" | "telegram"): string {
  return normalizeUrl(metadata[key]) || normalizeUrl(metadata.extensions?.[key]);
}

export function isPumpFunIpfsMetadataUri(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return value.trim().startsWith("https://ipfs.io/ipfs/");
}

export async function fetchTokenMetadata(uri: string): Promise<PumpTokenMetadata | null> {
  if (!uri) {
    return null;
  }

  for (let attempt = 0; attempt < config.pumpPortal.metadataFetchRetries; attempt += 1) {
    try {
      const response = await fetch(uri, { headers: { Accept: "application/json" } });
      if (response.ok) {
        return (await response.json()) as PumpTokenMetadata;
      }
    } catch {
      // Retry below.
    }

    if (attempt < config.pumpPortal.metadataFetchRetries - 1) {
      await delay(config.pumpPortal.metadataRetryDelayMs);
    }
  }

  return null;
}

export function isValidMeta(meta: PumpTokenMetadata | null): boolean {
  if (!meta) {
    return false;
  }

  return Boolean(meta.name && meta.symbol && meta.image);
}

export function getMissingMetaFields(meta: PumpTokenMetadata | null): string[] {
  if (!meta) {
    return ["name", "symbol", "image"];
  }

  const missing: string[] = [];

  if (!meta.name) {
    missing.push("name");
  }

  if (!meta.symbol) {
    missing.push("symbol");
  }

  if (!meta.image) {
    missing.push("image");
  }

  return missing;
}

export async function normalizePumpPortalToken(event: PumpPortalNewTokenEvent): Promise<PumpPortalTokenNormalizationResult> {
  const address = typeof event.mint === "string" ? event.mint : "";
  const creator =
    (typeof event.traderPublicKey === "string" ? event.traderPublicKey : "") ||
    (typeof event.creator === "string" ? event.creator : "");

  if (!address) {
    return {
      skipped: true,
      reason: `missing mint. event keys=${Object.keys(event).join(",")}`,
    };
  }

  if (!address.endsWith("pump")) {
    return {
      skipped: true,
      reason: `mint does not end with pump. mint=${address}`,
    };
  }

  if (!creator) {
    return {
      skipped: true,
      reason: `missing creator/traderPublicKey. event keys=${Object.keys(event).join(",")}`,
    };
  }

  const metadataUri = typeof event.uri === "string" ? event.uri : "";
  if (!isPumpFunIpfsMetadataUri(metadataUri)) {
    return {
      skipped: true,
      reason: `metadata uri is not https://ipfs.io/ipfs/. uri=${metadataUri || "missing"}`,
    };
  }

  const metadata = await fetchTokenMetadata(metadataUri);
  const metadataValid = isValidMeta(metadata);
  const missingMetadataFields = getMissingMetaFields(metadata);
  const createdTimestamp =
    typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : Math.floor(Date.now() / 1000);

  const token: GmgnTrenchToken = {
    address,
    symbol: typeof event.symbol === "string" ? event.symbol : metadata?.symbol || "",
    name: typeof event.name === "string" ? event.name : metadata?.name || "",
    creator,
    created_timestamp: createdTimestamp,
    launchpad_platform: "Pump.fun",
    liquidity: 0,
    usd_market_cap: 0,
    telegram: metadata ? getMetadataField(metadata, "telegram") : "",
    twitter: metadata ? getMetadataField(metadata, "twitter") : "",
    website: metadata ? getMetadataField(metadata, "website") : "",
    holder_count: 0,
    smart_degen_count: 0,
    renowned_count: 0,
    fund_from: "",
    fund_from_ts: 0,
    has_at_least_one_social: Boolean(
      metadata && (getMetadataField(metadata, "telegram") || getMetadataField(metadata, "twitter") || getMetadataField(metadata, "website")),
    ),
  };

  return {
    token,
    metadata,
    metadataValid,
    missingMetadataFields,
  };
}

export function connectPumpPortal(onEvent: (event: PumpPortalNewTokenEvent) => void): WebSocket {
  const ws = new WebSocket(config.pumpPortal.wsUrl);

  ws.on("open", () => {
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    logInfo("PumpPortal WebSocket connected and subscribed to new tokens.");
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as PumpPortalNewTokenEvent;
      onEvent(parsed);
    } catch {
      // Ignore malformed frames.
    }
  });

  return ws;
}
