import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type StoredCreds = { apiKey?: string };

export type CredentialSource =
  | "env"
  | "cliFlag"
  | "file"
  | "elicited"
  | "none";

export type ConfigLocation = {
  dir: string;
  scope: "explicit" | "project" | "global";
  source: "env" | "roots" | "cwdWalk" | "globalFallback";
};

const PROJECT_DIR_NAME = ".lido-mcp";
const PROJECT_MARKERS = [
  ".mcp.json",
  ".git",
  "package.json",
  ".claude",
] as const;

async function findProjectRoot(startDir: string): Promise<string | null> {
  const home = resolve(homedir());
  let dir = resolve(startDir);

  while (true) {
    if (dir === home) return null; // don't treat $HOME itself as a project
    for (const marker of PROJECT_MARKERS) {
      try {
        await access(join(dir, marker));
        return dir;
      } catch {
        /* not here */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

async function firstFileRoot(mcp: McpServer): Promise<string | null> {
  const caps = mcp.server.getClientCapabilities();
  if (!caps?.roots) return null;
  try {
    const result = await mcp.server.listRoots(undefined, { timeout: 5_000 });
    for (const root of result.roots ?? []) {
      const uri = root?.uri;
      if (typeof uri === "string" && uri.startsWith("file://")) {
        try {
          return fileURLToPath(uri);
        } catch {
          /* malformed uri — skip */
        }
      }
    }
  } catch {
    /* roots/list rejected or timed out — fall through */
  }
  return null;
}

async function resolveConfigLocation(
  mcp: McpServer | null,
): Promise<ConfigLocation> {
  const explicit = process.env.LIDO_CONFIG_DIR?.trim();
  if (explicit) return { dir: explicit, scope: "explicit", source: "env" };

  if (mcp) {
    const rootsDir = await firstFileRoot(mcp);
    if (rootsDir) {
      return {
        dir: join(rootsDir, PROJECT_DIR_NAME),
        scope: "project",
        source: "roots",
      };
    }
  }

  try {
    const projectRoot = await findProjectRoot(process.cwd());
    if (projectRoot) {
      return {
        dir: join(projectRoot, PROJECT_DIR_NAME),
        scope: "project",
        source: "cwdWalk",
      };
    }
  } catch {
    /* cwd unavailable — fall through */
  }

  return {
    dir: join(homedir(), ".config", "lido-mcp"),
    scope: "global",
    source: "globalFallback",
  };
}

async function readCredsFrom(dir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(dir, "credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as StoredCreds;
    return parsed.apiKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function cliFlagKey(): string | undefined {
  const i = process.argv.findIndex((a) => a === "--api-key");
  return i !== -1 ? process.argv[i + 1]?.trim() : undefined;
}

export class Credentials {
  private cachedKey: string | undefined;
  private cachedSource: CredentialSource = "none";
  private location: ConfigLocation | null = null;
  private loadedFromPath: string | null = null;
  private resolved = false;

  /**
   * Boot-time load: reads env / --api-key so the server can skip auth when a
   * key is already provided. File-backed credentials are *not* loaded here —
   * we defer that to {@link ensureResolved} so we can query the MCP client's
   * `roots` capability for a reliable project directory first.
   */
  async load(): Promise<void> {
    const envKey = process.env.LIDO_API_KEY?.trim();
    if (envKey) {
      this.cachedKey = envKey;
      this.cachedSource = "env";
      return;
    }

    const flagKey = cliFlagKey();
    if (flagKey) {
      this.cachedKey = flagKey;
      this.cachedSource = "cliFlag";
      return;
    }
  }

  /**
   * Resolves the credentials location (using MCP roots when available) and
   * reads any existing on-disk key. Idempotent — safe to call from every
   * tool invocation; the actual work happens at most once per process.
   */
  async ensureResolved(mcp: McpServer): Promise<void> {
    if (this.resolved) return;
    this.resolved = true;

    this.location = await resolveConfigLocation(mcp);

    if (this.location.source === "globalFallback") {
      process.stderr.write(
        "[lido-mcp] Warning: could not determine a project directory " +
          "(MCP client didn't report roots and no .mcp.json / .git / " +
          "package.json / .claude marker was found walking up from cwd). " +
          "Credentials will be saved in the global user config at " +
          `${this.location.dir}. Set LIDO_CONFIG_DIR to override.\n`,
      );
    }

    if (this.cachedSource !== "none") return; // env / cli already won

    const candidates: string[] = [this.location.dir];
    if (this.location.scope === "project") {
      candidates.push(join(homedir(), ".config", "lido-mcp"));
    }

    for (const dir of candidates) {
      const key = await readCredsFrom(dir);
      if (key) {
        this.cachedKey = key;
        this.cachedSource = "file";
        this.loadedFromPath = join(dir, "credentials.json");
        return;
      }
    }
  }

  get(): { apiKey: string; source: CredentialSource } | null {
    if (!this.cachedKey) return null;
    return { apiKey: this.cachedKey, source: this.cachedSource };
  }

  async save(apiKey: string): Promise<string> {
    const loc = this.location ?? (await resolveConfigLocation(null));
    const file = join(loc.dir, "credentials.json");

    await mkdir(loc.dir, { recursive: true, mode: 0o700 });

    if (loc.scope === "project") {
      await writeProjectGitignore(loc.dir);
    }

    await writeFile(
      file,
      JSON.stringify({ apiKey } satisfies StoredCreds, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await chmod(file, 0o600);
    } catch {
      /* non-POSIX FS — best effort */
    }

    this.cachedKey = apiKey;
    this.cachedSource = "elicited";
    this.location = loc;
    this.loadedFromPath = file;
    return file;
  }

  location_(): ConfigLocation | null {
    return this.location;
  }

  loadedFrom(): string | null {
    return this.loadedFromPath;
  }
}

async function writeProjectGitignore(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  try {
    await access(path);
    return; // already exists — don't clobber
  } catch {
    /* not present */
  }
  const body = [
    "# Created by lido-mcp — keep Lido API credentials out of version control.",
    "*",
    "!.gitignore",
    "",
  ].join("\n");
  await writeFile(path, body, "utf8");
}

export function describeLocation(loc: ConfigLocation): string {
  switch (loc.scope) {
    case "explicit":
      return `${loc.dir} (LIDO_CONFIG_DIR)`;
    case "project":
      return `${loc.dir} (project-scoped, via ${
        loc.source === "roots" ? "MCP client workspace roots" : "cwd walk"
      })`;
    case "global":
      return `${loc.dir} (global user config — no project detected)`;
  }
}
