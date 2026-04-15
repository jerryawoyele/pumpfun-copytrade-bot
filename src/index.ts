import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import { processNewTokenEvent } from "./bot.js";
import { connectPumpPortal } from "./clients/pumpportal.js";
import { config } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { isWithinRunWindow } from "./runtime.js";

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let pongTimeout: NodeJS.Timeout | null = null;
let heartbeatResetTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

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
  });

  heartbeatInterval = setInterval(() => {
    if (socket !== currentSocket || currentSocket.readyState !== 1) {
      return;
    }

    armPongTimeout(currentSocket);
    currentSocket.ping();
  }, config.pumpPortal.pingIntervalMs);

  heartbeatResetTimer = setTimeout(() => {
    if (socket !== currentSocket) {
      return;
    }

    logInfo("Resetting PumpPortal heartbeat connection.");
    currentSocket.terminate();
  }, config.pumpPortal.heartbeatResetMs);
}

async function ensureConnection(): Promise<void> {
  if (!isWithinRunWindow()) {
    closeSocket();
    return;
  }

  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    return;
  }

  logInfo(`Connecting to PumpPortal WebSocket: ${config.pumpPortal.wsUrl}`);
  socket = connectPumpPortal((event) => {
    const mint = typeof event.mint === "string" ? event.mint : "";
    if (!mint) {
      return;
    }

    void processNewTokenEvent(event).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to process token ${mint}: ${message}`);
    });
  });

  startHeartbeat(socket);

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
