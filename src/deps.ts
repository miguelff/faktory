import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * External tools serve depends on, with the command that installs each one.
 * Checks run at serve/orchestrate startup so a fresh machine self-heals
 * instead of failing later at dispatch time.
 */
export interface Dependency {
  bin: string;
  installCommand?: string;
}

const HARNESS_INSTALL: Record<string, string> = {
  pi: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

export function harnessDependency(kind: string): Dependency {
  return { bin: kind, installCommand: HARNESS_INSTALL[kind] };
}

export function herdrDependency(): Dependency {
  return { bin: "herdr", installCommand: "brew install herdr || curl -fsSL https://herdr.dev/install.sh | sh" };
}

export async function binExists(bin: string): Promise<boolean> {
  try {
    await exec("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

function runInstall(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${command}\` exited with code ${code}`)),
    );
  });
}

export async function ensureDependencies(deps: Dependency[]): Promise<void> {
  const seen = new Set<string>();
  for (const dep of deps) {
    if (seen.has(dep.bin)) continue;
    seen.add(dep.bin);
    if (await binExists(dep.bin)) continue;
    if (!dep.installCommand) {
      console.warn(`warning: ${dep.bin} not found and no installer is known for it — install it manually`);
      continue;
    }
    console.log(`⚙ ${dep.bin} not found — installing: ${dep.installCommand}`);
    await runInstall(dep.installCommand);
    if (!(await binExists(dep.bin))) {
      throw new Error(`${dep.bin} is still missing after install — check the output above`);
    }
    console.log(`⚙ ${dep.bin} installed`);
  }
}
