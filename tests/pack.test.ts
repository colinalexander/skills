import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parsePackId,
  isPackSource,
  fetchPackSnapshot,
  packSnapshotToBlobSkills,
  revokePack,
  type PackSnapshot,
} from '../src/pack.ts';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

const snapshot: PackSnapshot = {
  id: 'abc123',
  createdAt: '2026-06-26T00:00:00.000Z',
  sourceType: 'zip',
  sourceLabel: 'my-skills.zip',
  skills: [
    {
      name: 'First Skill',
      description: 'Does the first thing.',
      files: [
        {
          path: 'SKILL.md',
          contents: '---\nname: First Skill\ndescription: Does the first thing.\n---\n# First',
        },
        { path: 'references/notes.md', contents: 'notes' },
      ],
    },
    {
      name: 'Second Skill',
      description: 'Does the second thing.',
      files: [
        {
          path: 'SKILL.md',
          contents: '---\nname: Second Skill\ndescription: Does the second thing.\n---\n# Second',
        },
      ],
    },
  ],
};

describe('parsePackId', () => {
  it('parses bare host form', () => {
    expect(parsePackId('skills.sh/p/abc123')).toBe('abc123');
  });

  it('parses https form', () => {
    expect(parsePackId('https://skills.sh/p/abc123')).toBe('abc123');
  });

  it('parses www form', () => {
    expect(parsePackId('https://www.skills.sh/p/abc123')).toBe('abc123');
  });

  it('parses trailing slash', () => {
    expect(parsePackId('skills.sh/p/abc123/')).toBe('abc123');
  });

  it('rejects non-skills.sh host', () => {
    expect(parsePackId('https://example.com/p/abc123')).toBeNull();
  });

  it('rejects non-pack skills.sh path', () => {
    expect(parsePackId('skills.sh/owner/repo')).toBeNull();
  });

  it('isPackSource matches pack urls only', () => {
    expect(isPackSource('skills.sh/p/abc123')).toBe(true);
    expect(isPackSource('owner/repo')).toBe(false);
  });
});

describe('fetchPackSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the snapshot from /api/p/<id>', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(snapshot));

    const result = await fetchPackSnapshot('abc123');

    expect(result).toEqual(snapshot);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://skills.sh/api/p/abc123');
  });

  it('returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, { status: 404 }));
    const result = await fetchPackSnapshot('missing');
    expect(result).toBeNull();
  });

  it('honors SKILLS_DOWNLOAD_URL override', async () => {
    const original = process.env.SKILLS_DOWNLOAD_URL;
    process.env.SKILLS_DOWNLOAD_URL = 'http://localhost:3000';
    vi.resetModules();
    try {
      const fresh = await import('../src/pack.ts?override');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(snapshot));
      await fresh.fetchPackSnapshot('abc123');
      expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://localhost:3000/api/p/abc123');
    } finally {
      if (original === undefined) {
        delete process.env.SKILLS_DOWNLOAD_URL;
      } else {
        process.env.SKILLS_DOWNLOAD_URL = original;
      }
    }
  });
});

describe('packSnapshotToBlobSkills', () => {
  it('converts every skill in the pack', () => {
    const skills = packSnapshotToBlobSkills(snapshot);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(['First Skill', 'Second Skill']);
  });

  it('carries files and points repoPath at SKILL.md', () => {
    const [first] = packSnapshotToBlobSkills(snapshot);
    expect(first!.files).toHaveLength(2);
    expect(first!.repoPath).toBe('SKILL.md');
    expect(first!.rawContent).toContain('name: First Skill');
    expect(first!.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('revokePack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the token to /p/<id>/revoke', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

    const result = await revokePack('abc123', 'rvk_secret');

    expect(result.success).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://skills.sh/p/abc123/revoke');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ token: 'rvk_secret' });
  });

  it('returns success=false on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, { status: 404 }));
    const result = await revokePack('abc123', 'wrong');
    expect(result.success).toBe(false);
  });
});
