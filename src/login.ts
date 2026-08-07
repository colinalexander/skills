import { createHash, randomBytes } from 'crypto';
import type { AuthUser } from './auth-store.ts';

export const DEFAULT_BASE_URL = process.env.SKILLS_DOWNLOAD_URL || 'https://skills.sh';
const EXCHANGE_TIMEOUT_MS = 15_000;

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

export function buildAuthorizeUrl(
  baseUrl: string,
  port: number,
  challenge: string,
  state: string
): string {
  const url = new URL('/cli/authorize', baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
  return url.toString();
}

export interface TokenExchangeResult {
  token: string;
  user?: AuthUser;
}

export async function exchangeCodeForToken(
  baseUrl: string,
  params: { code: string; codeVerifier: string; state: string }
): Promise<TokenExchangeResult> {
  const res = await fetch(new URL('/api/cli/token', baseUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: params.code,
      code_verifier: params.codeVerifier,
      state: params.state,
    }),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return (await res.json()) as TokenExchangeResult;
}
