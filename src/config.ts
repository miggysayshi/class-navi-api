/** Environment configuration. Credentials come from env vars only — never hardcode. */

export interface ClassNaviConfig {
  /** Login ID shown on the Class-Navi login page. */
  username: string;
  /** Password for the login page. */
  password: string;
  /** Country code (systemCountryCD) — the web app uses "USA". */
  countryCd: string;
  /** RPC endpoint base URL. */
  apiUrl: string;
  /** OAuth2 token endpoint. */
  tokenUrl: string;
  /** Request timeout in milliseconds. */
  requestTimeoutMs: number;
}

const DEFAULTS = {
  countryCd: "USA",
  apiUrl: "https://instructor2-lon.digital.kumon.com/USA/api",
  tokenUrl: "https://instructor2-lon.digital.kumon.com/USA/token",
  requestTimeoutMs: 60_000,
} as const;

export function loadConfig(env: Record<string, string | undefined> = Bun.env): ClassNaviConfig {
  const username = env.CLASSNAVI_USERNAME ?? "";
  const password = env.CLASSNAVI_PASSWORD ?? "";
  if (!username || !password) {
    throw new Error(
      "Missing credentials. Set CLASSNAVI_USERNAME and CLASSNAVI_PASSWORD (see .env.example).",
    );
  }
  return {
    username,
    password,
    countryCd: env.CLASSNAVI_COUNTRY_CD ?? DEFAULTS.countryCd,
    apiUrl: env.CLASSNAVI_API_URL ?? DEFAULTS.apiUrl,
    tokenUrl: env.CLASSNAVI_TOKEN_URL ?? DEFAULTS.tokenUrl,
    requestTimeoutMs: Number(env.CLASSNAVI_REQUEST_TIMEOUT_MS ?? DEFAULTS.requestTimeoutMs),
  };
}

/** Load a .env file from the project root if present. */
export async function loadDotEnv(path = `${import.meta.dir}/../.env`): Promise<void> {
  try {
    const text = await Bun.file(path).text();
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in Bun.env)) Bun.env[m[1]] = m[2];
    }
  } catch {
    // no .env file — env vars may be set externally
  }
}
