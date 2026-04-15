import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GmgnTrenchToken } from "../types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

interface GmgnTokenInfoResponse {
  link?: {
    twitter_username?: string;
    website?: string;
    telegram?: string;
  };
}

async function runGmgn(args: string[]): Promise<string> {
  if (process.platform === "win32") {
    const command = ["gmgn-cli", ...args].join(" ");
    const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024, shell: "powershell.exe" });
    return stdout;
  }

  const { stdout } = await execFileAsync("gmgn-cli", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

function normalizeTwitter(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `https://x.com/${trimmed}`;
}

export async function enrichTokenWithGmgnSocials(token: GmgnTrenchToken): Promise<GmgnTrenchToken> {
  try {
    const stdout = await runGmgn(["token", "info", "--chain", "sol", "--address", token.address, "--raw"]);
    const parsed = JSON.parse(stdout) as GmgnTokenInfoResponse;

    const twitter = token.twitter || normalizeTwitter(parsed.link?.twitter_username);
    const website = token.website || parsed.link?.website || "";
    const telegram = token.telegram || parsed.link?.telegram || "";

    return {
      ...token,
      twitter,
      website,
      telegram,
      has_at_least_one_social: Boolean(twitter || website || telegram),
    };
  } catch {
    return token;
  }
}
