import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import { processNewTokenEvent } from "./bot.js";
import { connectPumpPortal } from "./clients/pumpportal.js";
import { config } from "./config.js";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";
import { isWithinRunWindow } from "./runtime.js";

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let pongTimeout: NodeJS.Timeout | null = null;
let heartbeatResetTimer: NodeJS.Timeout | null = null;
const inFlightMints = new Set<string>();
let lastOutsideRunWindowLogAt = 0;

function getRuntimeSnapshot(): string {
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.runtime.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

  return `run_window=${config.runtime.runWindowStart}-${config.runtime.runWindowEnd} timezone=${config.runtime.timezone} local_time=${localTime}`;
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  logDebug(`Scheduling PumpPortal reconnect in ${config.pumpPortal.reconnectDelayMs}ms.`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnection();
  }, config.pumpPortal.reconnectDelayMs);
}

function closeSocket(): void {
  clearHeartbeat();

  if (!socket) {
    return;
  }

  socket.removeAllListeners();
  socket.close();
  socket = null;
}

function clearHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (pongTimeout) {
    clearTimeout(pongTimeout);
    pongTimeout = null;
  }

  if (heartbeatResetTimer) {
    clearTimeout(heartbeatResetTimer);
    heartbeatResetTimer = null;
  }
}

function armPongTimeout(currentSocket: WebSocket): void {
  if (pongTimeout) {
    clearTimeout(pongTimeout);
  }

  pongTimeout = setTimeout(() => {
    if (socket !== currentSocket) {
      return;
    }

    logDebug(`PumpPortal pong timeout reached after ${config.pumpPortal.pongTimeoutMs}ms.`);
    logWarn("PumpPortal heartbeat timed out. Reconnecting...");
    currentSocket.terminate();
  }, config.pumpPortal.pongTimeoutMs);
}

function startHeartbeat(currentSocket: WebSocket): void {
  clearHeartbeat();

  currentSocket.on("pong", () => {
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }

    logDebug("Received PumpPortal pong frame.");
  });

  heartbeatInterval = setInterval(() => {
    if (socket !== currentSocket || currentSocket.readyState !== 1) {
      return;
    }

    armPongTimeout(currentSocket);
    logDebug("Sending PumpPortal ping frame.");
    currentSocket.ping();
  }, config.pumpPortal.pingIntervalMs);

  heartbeatResetTimer = setTimeout(() => {
    if (socket !== currentSocket) {
      return;
    }

    logDebug(`Heartbeat reset threshold reached after ${config.pumpPortal.heartbeatResetMs}ms.`);
    logInfo("Resetting PumpPortal heartbeat connection.");
    currentSocket.terminate();
  }, config.pumpPortal.heartbeatResetMs);
}

async function ensureConnection(): Promise<void> {
  if (!isWithinRunWindow()) {
    const now = Date.now();
    if (now - lastOutsideRunWindowLogAt >= 60000) {
      logInfo(`Outside configured run window; PumpPortal socket will stay closed. ${getRuntimeSnapshot()}`);
      lastOutsideRunWindowLogAt = now;
    }

    closeSocket();
    return;
  }

  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    logDebug(`PumpPortal socket already active with readyState=${socket.readyState}.`);
    return;
  }

  logInfo(`Connecting to PumpPortal WebSocket: ${config.pumpPortal.wsUrl}`);
  socket = connectPumpPortal((event) => {
    const mint = typeof event.mint === "string" ? event.mint : "";
    if (!mint) {
      logDebug("Ignoring PumpPortal message without a mint address.");
      return;
    }

    if (inFlightMints.has(mint)) {
      logDebug(`Skipping duplicate in-flight PumpPortal event for ${mint}.`);
      return;
    }

    inFlightMints.add(mint);
    void processNewTokenEvent(event)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (config.runtime.debugPipeline) {
          logWarn(`Failed to process token ${mint}: ${message}`);
        } else {
          logDebug(`Failed to process token ${mint}: ${message}`);
        }
      })
      .finally(() => {
        inFlightMints.delete(mint);
      });
  });

  startHeartbeat(socket);
  logDebug("PumpPortal socket connected; heartbeat timers started.");

  socket.on("close", () => {
    logWarn("PumpPortal WebSocket closed.");
    clearHeartbeat();
    socket = null;
    if (isWithinRunWindow()) {
      scheduleReconnect();
    }
  });

  socket.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`PumpPortal WebSocket error: ${message}`);
  });
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  logInfo(
    `Bot booted. ${getRuntimeSnapshot()} live_buy=${config.jupiter.enableLiveBuy} debug_pipeline=${config.runtime.debugPipeline}`,
  );

  if (once) {
    if (!isWithinRunWindow()) {
      logInfo(
        `Outside run window ${config.runtime.runWindowStart}-${config.runtime.runWindowEnd} (${config.runtime.timezone}), not starting websocket.`,
      );
      return;
    }

    await ensureConnection();
    await delay(30000);
    closeSocket();
    return;
  }

  do {
    try {
      await ensureConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(message);
    }

    await delay(1000);
  } while (true);
}

void main();
