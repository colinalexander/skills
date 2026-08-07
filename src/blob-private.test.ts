import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolvePrivateInstall } from './blob.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('resolvePrivateInstall', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a 200 snapshot set to BlobSkills', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          skills: [
            {
              name: 'My Skill',
              repoPath: 'skills/my-skill/SKILL.md',
              files: [{ path: 'SKILL.md', contents: '---\nname: My Skill\n---\n' }],
              hash: 'abc',
            },
          ],
        })
      )
    );
    const result = await resolvePrivateInstall('acme/private', { token: 'tok' });
    expect(result.status).toBe('ok');
    expect(result.skills).toHaveLength(1);
    const skill = result.skills![0]!;
    expect(skill.name).toBe('My Skill');
    expect(skill.repoPath).toBe('skills/my-skill/SKILL.md');
    expect(skill.snapshotHash).toBe('abc');
    expect(skill.files[0]!.path).toBe('SKILL.md');
    expect(skill.path).toBe('');
  });

  it('sends the Authorization header and correct body when a token is provided', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: { headers: Record<string, string>; body: string }) =>
        jsonResponse({ skills: [] })
    );
    vi.stubGlobal('fetch', fetchMock);
    await resolvePrivateInstall('acme/private', { token: 'tok', ref: 'main', skill: 's' });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({
      owner: 'acme',
      repo: 'private',
      ref: 'main',
      skill: 's',
    });
  });

  it('omits Authorization when no token', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: { headers: Record<string, string>; body: string }) =>
        jsonResponse({ skills: [] })
    );
    vi.stubGlobal('fetch', fetchMock);
    await resolvePrivateInstall('acme/private', {});
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers.authorization).toBeUndefined();
  });

  it('returns unauthorized on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 }))
    );
    expect((await resolvePrivateInstall('a/b', {})).status).toBe('unauthorized');
  });

  it('returns forbidden on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 }))
    );
    expect((await resolvePrivateInstall('a/b', { token: 't' })).status).toBe('forbidden');
  });

  it('returns not-found on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    );
    expect((await resolvePrivateInstall('a/b', { token: 't' })).status).toBe('not-found');
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    expect((await resolvePrivateInstall('a/b', { token: 't' })).status).toBe('error');
  });

  it('returns error on a malformed owner/repo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ skills: [] }))
    );
    expect((await resolvePrivateInstall('noslash', { token: 't' })).status).toBe('error');
  });
});
