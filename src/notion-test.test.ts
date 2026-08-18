import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNotionPackDirectory,
  fetchNotionPacks,
  isNotionSource,
  prepareNotionPackSource,
  type NotionPack,
  type NtnRunner,
} from './notion-test.ts';
import { discoverSkills } from './skills.ts';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function listResponse(
  results: unknown[],
  options: { hasMore?: boolean; nextCursor?: string | null } = {}
): string {
  return JSON.stringify({
    object: 'list',
    results,
    next_cursor: options.nextCursor ?? null,
    has_more: options.hasMore ?? false,
    type: 'plugin',
  });
}

describe('Notion pack prototype', () => {
  it('uses only paginated ntn list calls and returns packs without fetching details', async () => {
    const runNtn = vi.fn<NtnRunner>(async (args) => {
      const cursor = args.find((arg) => arg.startsWith('start_cursor=='));
      if (!cursor) {
        return listResponse(
          [
            {
              id: '>tO?',
              name: 'Company-wide',
              description: '',
              version_id: 'a'.repeat(64),
            },
          ],
          { hasMore: true, nextCursor: 'next123' }
        );
      }

      return listResponse([
        {
          id: '6be44900-5769-4e54-ba7e-a6411285f214',
          name: 'Draft Skills',
          description: 'Draft plugin pack',
          version_id: 'b'.repeat(64),
        },
      ]);
    });

    const packs = await fetchNotionPacks({ runNtn });

    expect(packs.map((pack) => pack.name)).toEqual(['Company-wide', 'Draft Skills']);
    expect(runNtn).toHaveBeenCalledTimes(2);
    expect(runNtn).toHaveBeenNthCalledWith(1, [
      'api',
      '/v1/ai/plugins',
      'page_size==100',
      '--notion-version',
      '2026-03-11',
    ]);
    expect(runNtn).toHaveBeenNthCalledWith(2, [
      'api',
      '/v1/ai/plugins',
      'page_size==100',
      'start_cursor==next123',
      '--notion-version',
      '2026-03-11',
    ]);
    expect(runNtn.mock.calls.flat(2).join(' ')).not.toContain('/v1/ai/plugins/>tO?');
    expect(runNtn.mock.calls.flat(2).join(' ')).not.toContain(
      '/v1/ai/plugins/6be44900-5769-4e54-ba7e-a6411285f214'
    );
  });

  it('accepts omitted pack descriptions from the alpha API', async () => {
    const runNtn = vi.fn<NtnRunner>(async () =>
      listResponse([
        {
          id: '~R\\;',
          name: 'Product Design',
          version_id: 'a'.repeat(64),
        },
      ])
    );

    const packs = await fetchNotionPacks({ runNtn });

    expect(packs).toEqual([
      {
        id: '~R\\;',
        name: 'Product Design',
        description: '',
        version_id: 'a'.repeat(64),
      },
    ]);
  });

  it('percent-encodes opaque pack IDs for lazy directory lookup', async () => {
    const pack: NotionPack = {
      id: '>tO?',
      name: 'Company-wide',
      description: '',
      version_id: 'a'.repeat(64),
    };
    const runNtn = vi.fn<NtnRunner>(async () =>
      JSON.stringify({
        id: pack.id,
        version_id: pack.version_id,
        url: 'https://downloads.example/company-wide.tgz',
      })
    );

    const directory = await fetchNotionPackDirectory(pack, { runNtn });

    expect(directory.url).toBe('https://downloads.example/company-wide.tgz');
    expect(runNtn).toHaveBeenCalledWith([
      'api',
      '/v1/ai/plugins/%3EtO%3F',
      '--notion-version',
      '2026-03-11',
    ]);
  });

  it('stages selected packs as one grouped local install source', async () => {
    const pack: NotionPack = {
      id: '>tO?',
      name: 'Company-wide',
      description: '',
      version_id: 'a'.repeat(64),
    };
    const downloadTemp = mkdtempSync(join(tmpdir(), 'notion-pack-download-test-'));
    cleanupDirs.push(downloadTemp);
    const downloadRoot = join(downloadTemp, 'company-wide');
    const skillDir = join(downloadRoot, 'skills', 'write-update');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: write-update\ndescription: Write a company update\n---\n'
    );

    const runNtn = vi.fn<NtnRunner>(async (args) => {
      if (args[1] === '/v1/ai/plugins') return listResponse([pack]);
      return JSON.stringify({
        id: pack.id,
        version_id: pack.version_id,
        url: 'https://downloads.example/company-wide.tgz',
      });
    });

    const prepared = await prepareNotionPackSource({
      yes: true,
      runNtn,
      download: vi.fn(async () => ({
        rootDir: downloadRoot,
        tempDir: downloadTemp,
        kind: 'archive' as const,
      })),
    });

    expect(prepared).not.toBeNull();
    cleanupDirs.push(prepared!.tempDir);
    const stagedSkills = await discoverSkills(prepared!.rootDir, undefined, { fullDepth: true });
    expect(
      stagedSkills.map((skill) => ({ name: skill.name, pluginName: skill.pluginName }))
    ).toEqual([{ name: 'write-update', pluginName: 'Company-wide' }]);
    expect(prepared).toMatchObject({ packCount: 1, skillCount: 1 });
    expect(runNtn).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid repeated pagination cursors', async () => {
    const runNtn = vi.fn<NtnRunner>(async () =>
      listResponse([], { hasMore: true, nextCursor: 'same123' })
    );

    await expect(fetchNotionPacks({ runNtn })).rejects.toThrow(
      'Notion Agent Plugins pagination returned an invalid cursor'
    );
    expect(runNtn).toHaveBeenCalledTimes(2);
  });

  it('reports invalid JSON returned by ntn', async () => {
    const runNtn = vi.fn<NtnRunner>(async () => 'not json');

    await expect(fetchNotionPacks({ runNtn })).rejects.toThrow(
      'ntn returned invalid JSON for the Notion packs list'
    );
  });

  it.each(['notion', 'NOTION'])('recognizes %s as a Notion source', (source) => {
    expect(isNotionSource(source)).toBe(true);
  });

  it.each([
    'notion-test',
    'https://www.notion.so/acme/Skills-123',
    'https://acme.notion.site/Skills-123',
    'notion.example',
    'https://example.com/notion',
    'owner/notion',
  ])('does not treat %s as a Notion source', (source) => {
    expect(isNotionSource(source)).toBe(false);
  });
});
