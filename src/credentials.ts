import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
};

const PROJECT_DIR_NAME = ".lido-mcp";
const PROJECT_MARKERS = [".mcp.json", ".git", "package.json"] as const;

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

async function resolveConfigLocation(): Promise<ConfigLocation> {
  const explicit = process.env.LIDO_CONFIG_DIR?.trim();
  if (explicit) return { dir: explicit, scope: "explicit" };

  try {
    const projectRoot = await findProjectRoot(process.cwd());
    if (projectRoot) {
      return { dir: join(projectRoot, PROJECT_DIR_NAME), scope: "project" };
    }
  } catch {
    /* cwd unavailable — fall through */
  }

  return {
    dir: join(homedir(), ".config", "lido-mcp"),
    scope: "global",
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

  async load(): Promise<void> {
    const envKey = process.env.LIDO_API_KEY?.trim();
    if (envKey) {
      this.cachedKey = envKey;
      this.cachedSource = "env";
      this.location = await resolveConfigLocation();
      return;
    }

    const flagKey = cliFlagKey();
    if (flagKey) {
      this.cachedKey = flagKey;
      this.cachedSource = "cliFlag";
      this.location = await resolveConfigLocation();
      return;
    }

    this.location = await resolveConfigLocation();

    // Priority search: the resolved save location first, then the less-specific
    // fallbacks. A project-scoped credential wins over a global one; an explicit
    // LIDO_CONFIG_DIR is authoritative and we don't fall further.
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
    const loc = this.location ?? (await resolveConfigLocation());
    const file = join(loc.dir, "credentials.json");

    await mkdir(loc.dir, { recursive: true, mode: 0o700 });

    if (loc.scope === "project") {
      await writeProjectGitignore(loc.dir);
    }

    await writeFile(file, JSON.stringify({ apiKey } satisfies StoredCreds, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
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
      return `${loc.dir} (project-scoped)`;
    case "global":
      return `${loc.dir} (global user config)`;
  }
}
