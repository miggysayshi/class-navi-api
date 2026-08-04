/**
 * OAuth2 password-grant token manager, faithful to Class-Navi's client:
 *  - login:  POST <tokenUrl>  grant_type=password&username=<id>&password=<hash>
 *  - refresh: POST <tokenUrl>  grant_type=refresh_token&refresh_token=<rt>
 *  - token considered expired `expires_in - 30s` after issue
 *  - API requests carry `Authorization: Bearer <token>` + `X-User-ID: <userName>`
 */

import type { ClassNaviConfig } from "./config";
import { hashPassword } from "./crypto";

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  userName: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class TokenManager {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private xUserID: string | null = null;
  private expiresAtInternal: Date | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly config: ClassNaviConfig) {}

  /** True once a token is held and not yet expired. */
  get isAuthenticated(): boolean {
    return !!this.accessToken && !!this.expiresAtInternal && this.expiresAtInternal > new Date();
  }

  get userId(): string | null {
    return this.xUserID;
  }

  /** When the current access token expires (server time + expires_in − 30s). */
  get expiresAt(): Date | null {
    return this.expiresAtInternal;
  }

  private async postForm(body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new AuthError(`Token endpoint returned HTTP ${res.status}`, "Authenticate", res.status);
    }
    return (await res.json()) as TokenResponse;
  }

  /** Password-grant login, faithful to the web app's `onClick_loginBtn`:
   *  - token username = `${countryCd}/${loginId}`  (e.g. "USA/00970532")
   *  - hash salt      = `${countryCd}${loginId}`   (e.g. "USA00970532") */
  async login(): Promise<void> {
    const { username, password, countryCd } = this.config;
    const passwordHash = await hashPassword(password, `${countryCd}${username}`);
    const body = new URLSearchParams({
      grant_type: "password",
      username: `${countryCd}/${username}`,
      password: passwordHash,
    });
    const token = await this.postForm(body);
    this.applyToken(token);
  }

  /** Exchange the stored refresh token for a fresh access token. */
  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new AuthError("No refresh token available", "NotLogin");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
    });
    const token = await this.postForm(body);
    this.applyToken(token);
  }

  private applyToken(token: TokenResponse): void {
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token;
    this.xUserID = token.userName;
    const exp = new Date();
    exp.setSeconds(exp.getSeconds() + token.expires_in - 30);
    this.expiresAtInternal = exp;
  }

  /**
   * Ensure a non-expired access token exists (logging in on first use,
   * refreshing when near expiry). Concurrent callers share one refresh.
   */
  async ensureFresh(): Promise<void> {
    if (this.isAuthenticated) return;
    if (this.refreshToken) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refresh().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
      return;
    }
    await this.login();
  }

  /** Headers for an API call. Call after ensureFresh(). */
  authHeaders(): Record<string, string> {
    if (!this.accessToken || !this.xUserID) {
      throw new AuthError("Not authenticated — call ensureFresh() first", "NotLogin");
    }
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "X-User-ID": this.xUserID,
    };
  }
}
