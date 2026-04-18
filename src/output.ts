import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_DIR = join(tmpdir(), "lido-mcp");

export async function writeResultFile(
  suggestedName: string,
  content: string,
  outputPath?: string,
): Promise<string> {
  const target = outputPath
    ? isAbsolute(outputPath)
      ? outputPath
      : resolve(process.cwd(), outputPath)
    : join(DEFAULT_DIR, `${timestamp()}-${suggestedName}`);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
