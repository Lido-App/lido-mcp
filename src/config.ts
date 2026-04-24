const DEFAULT_BASE_URL = "https://sheets.lido.app";

export function getBaseUrl(): string {
  const raw = process.env.LIDO_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  return `${getBaseUrl()}/api/v1`;
}
