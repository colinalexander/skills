import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  generatePkce,
  generateState,
  base64UrlEncode,
  buildAuthorizeUrl,
  exchangeCodeForToken,
} from './login.ts';

describe('login core', () => {
  afterEach(() => vi.restoreAllMocks());

  it('generatePkce produces a verifier and its S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it('generateState is url-safe and non-empty', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('buildAuthorizeUrl includes required query params', () => {
    const url = new URL(buildAuthorizeUrl('https://skills.sh', 41234, 'CH', 'ST'));
    expect(url.pathname).toBe('/cli/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('CH');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:41234/callback');
  });

  it('exchangeCodeForToken posts and returns token+user', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: 'tok', user: { id: 'u', handle: 'h', email: 'e' } }), {
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await exchangeCodeForToken('https://skills.sh', {
      code: 'c',
      codeVerifier: 'v',
      state: 's',
    });
    expect(result.token).toBe('tok');
    expect(result.user?.handle).toBe('h');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({ code: 'c', code_verifier: 'v', state: 's' });
  });

  it('exchangeCodeForToken throws on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 }))
    );
    await expect(
      exchangeCodeForToken('https://skills.sh', { code: 'c', codeVerifier: 'v', state: 's' })
    ).rejects.toThrow(/400/);
  });
});
