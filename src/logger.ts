export function logInfo(message: string): void {
  console.log(`[INFO] ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`[WARN] ${message}`);
}

export function logError(message: string): void {
  console.error(`[ERROR] ${message}`);
}

export function logSuccess(message: string): void {
  console.log(`[SUCCESS] ${message}`);
}

export function logFound(message: string): void {
  console.log(`[FOUND] ${message}`);
}

export function logSignal(message: string): void {
  console.log(`[SIGNAL] ${message}`);
}
