import { spawn } from "node:child_process";
import { platform } from "node:os";

export type OpenResult = { opened: boolean; reason?: string };

/**
 * Attempt to open the given URL in the user's default browser, cross-platform.
 *
 * Returns `{ opened: true }` if the launcher command spawned successfully; it does
 * not guarantee a window is actually visible (that's up to the OS). On failure,
 * returns `{ opened: false, reason }` so the caller can print the URL for the
 * user to open manually.
 */
export async function openBrowser(url: string): Promise<OpenResult> {
  const { cmd, args } = commandFor(url);
  if (!cmd) {
    return { opened: false, reason: `Unsupported platform: ${platform()}` };
  }

  return new Promise<OpenResult>((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.once("error", (err) => {
        resolve({ opened: false, reason: err.message });
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ opened: true });
      });
    } catch (err) {
      resolve({
        opened: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function commandFor(url: string): { cmd: string | null; args: string[] } {
  switch (platform()) {
    case "darwin":
      return { cmd: "open", args: [url] };
    case "win32":
      // `start` is a cmd.exe builtin — an empty "" is the window title argument.
      return { cmd: "cmd", args: ["/c", "start", "", url] };
    case "linux":
    case "freebsd":
    case "openbsd":
    case "sunos":
      // xdg-open is the freedesktop standard; most distros ship it.
      return { cmd: "xdg-open", args: [url] };
    default:
      return { cmd: null, args: [] };
  }
}
