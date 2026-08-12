import { describe, it, expect, vi, afterEach } from 'vitest';
import { wellKnownProvider, WellKnownAuthError } from './providers/wellknown.ts';

afterEach(() => vi.restoreAllMocks());

describe('well-known auth surfacing', () => {
  it('throws WellKnownAuthError(401) when the index returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 }))
    );
    await expect(
      wellKnownProvider.fetchAllSkills('https://skills.sh/p/acme-foo')
    ).rejects.toBeInstanceOf(WellKnownAuthError);
  });

  it('sends Authorization when a token is passed and surfaces 403', async () => {
    const fetchMock = vi.fn(
      async (_url?: string, _init?: RequestInit) => new Response('no', { status: 403 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      wellKnownProvider.fetchAllSkills('https://skills.sh/p/acme-foo', { token: 'cli_x' })
    ).rejects.toMatchObject({ status: 403 });
    const sentAuth = fetchMock.mock.calls.some(([, init]) => {
      const h = (init as any)?.headers ?? {};
      return h.Authorization === 'Bearer cli_x' || h.authorization === 'Bearer cli_x';
    });
    expect(sentAuth).toBe(true);
  });
});
