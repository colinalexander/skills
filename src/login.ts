import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { getToken, setToken, clearToken, isEnvToken, type AuthUser } from './auth-store.ts';

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
  const result = (await res.json()) as TokenExchangeResult;
  if (typeof result?.token !== 'string' || result.token.trim().length === 0) {
    throw new Error('Token exchange returned no access token');
  }
  return result;
}

const CALLBACK_TIMEOUT_MS = 120_000;

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    void 0;
  }
}

interface CallbackResult {
  code: string;
}

function waitForCallback(
  baseUrl: string,
  challenge: string,
  state: string,
  interactive: boolean
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = reqUrl.searchParams.get('error');
      const gotState = reqUrl.searchParams.get('state');
      const code = reqUrl.searchParams.get('code');
      if (err || gotState !== state || !code) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<html><body>Login failed. You can close this tab.</body></html>');
        cleanup();
        reject(new Error(err ? `Authorization error: ${err}` : 'State mismatch or missing code'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Login complete. You can close this tab.</body></html>');
      cleanup();
      resolve({ code });
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Login timed out. Please try again.'));
    }, CALLBACK_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on('error', (e) => {
      cleanup();
      reject(e);
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const authorizeUrl = buildAuthorizeUrl(baseUrl, port, challenge, state);
      console.log(`Opening your browser to sign in:\n  ${authorizeUrl}\n`);
      if (interactive) openBrowser(authorizeUrl);
    });
  });
}

export async function runLogin(baseUrl: string = DEFAULT_BASE_URL): Promise<void> {
  if (isEnvToken()) {
    console.log('SKILLS_TOKEN is set in the environment; already authenticated.');
    return;
  }
  const interactive = process.stdin.isTTY === true || process.stdout.isTTY === true;
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  try {
    const { code } = await waitForCallback(baseUrl, challenge, state, interactive);
    const result = await exchangeCodeForToken(baseUrl, { code, codeVerifier: verifier, state });
    setToken(result.token, result.user);
    console.log(`Logged in${result.user ? ` as ${result.user.handle}` : ''}.`);
  } catch (e) {
    console.error(`Login failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runWhoami(baseUrl: string = DEFAULT_BASE_URL): Promise<void> {
  const tok = getToken();
  if (!tok) {
    console.log('Not logged in. Run `skills login`.');
    process.exitCode = 1;
    return;
  }
  try {
    const res = await fetch(new URL('/api/me', baseUrl).toString(), {
      headers: { authorization: `Bearer ${tok.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      console.log('Token invalid or expired. Run `skills login`.');
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(`Could not verify identity (${res.status}). Try again later.`);
      process.exitCode = 1;
      return;
    }
    const { user } = (await res.json()) as { user: AuthUser };
    console.log(`${user.handle} <${user.email}> (token source: ${tok.source})`);
  } catch (e) {
    console.error(`Could not verify identity: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runLogout(baseUrl: string = DEFAULT_BASE_URL): Promise<void> {
  if (isEnvToken()) {
    console.log('SKILLS_TOKEN is set in the environment; unset it to log out.');
    return;
  }
  const tok = getToken();
  if (tok) {
    await fetch(new URL('/api/cli/revoke', baseUrl).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  clearToken();
  console.log('Logged out.');
}
