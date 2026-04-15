import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";

interface BuyStateFile {
  version: 1;
  bought: Record<string, { boughtAt: string; signature: string | null }>;
}

export class BuyState {
  private readonly filePath: string;
  private readonly bought = new Map<string, { boughtAt: string; signature: string | null }>();

  private constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  static async create(): Promise<BuyState> {
    const state = new BuyState(config.jupiter.buyStateFile);
    await state.load();
    return state;
  }

  has(tokenMint: string): boolean {
    return this.bought.has(tokenMint);
  }

  async markBought(tokenMint: string, signature: string | null): Promise<void> {
    this.bought.set(tokenMint, { boughtAt: new Date().toISOString(), signature });
    await this.persist();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BuyStateFile>;
      if (!parsed.bought || typeof parsed.bought !== "object") {
        return;
      }

      for (const [tokenMint, value] of Object.entries(parsed.bought)) {
        if (value && typeof value === "object" && typeof value.boughtAt === "string") {
          this.bought.set(tokenMint, {
            boughtAt: value.boughtAt,
            signature: typeof value.signature === "string" ? value.signature : null,
          });
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: BuyStateFile = {
      version: 1,
      bought: Object.fromEntries(this.bought.entries()),
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
