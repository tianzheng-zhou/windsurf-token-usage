import * as vscode from "vscode";

/**
 * Lazily-created, extension-scoped output channel. Kept lazy so that running
 * under `npm test` or any environment without a VS Code host doesn't blow up
 * on the synchronous call to `createOutputChannel`.
 */
let channel: vscode.OutputChannel | null = null;

function ensureChannel(): vscode.OutputChannel | null {
  if (channel) {
    return channel;
  }
  try {
    channel = vscode.window.createOutputChannel("Windsurf Token Usage");
    return channel;
  } catch {
    return null;
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(...parts: unknown[]): void {
  const ch = ensureChannel();
  if (!ch) {
    return;
  }
  const line = parts
    .map((p) =>
      typeof p === "string"
        ? p
        : (() => {
            try {
              return JSON.stringify(p);
            } catch {
              return String(p);
            }
          })()
    )
    .join(" ");
  ch.appendLine(`[${ts()}] ${line}`);
}

export function showLogs(): void {
  ensureChannel()?.show(true);
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = null;
}
