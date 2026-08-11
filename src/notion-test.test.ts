import { describe, expect, it, vi } from 'vitest';
import {
  fetchNotionPluginDownloads,
  loadNotionPluginSkills,
  type NotionFetch,
} from './notion-test.ts';
import type { Skill } from './types.ts';

const PLUGIN_ONE_ID = '04bc94c5-1a64-49c5-ac4c-5f603c1a0146';
const PLUGIN_TWO_ID = '6be44900-5769-4e54-ba7e-a6411285f214';

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Notion Agent Plugins prototype', () => {
  it('accepts plugin summaries without a description', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === '/v1/ai/plugins') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: PLUGIN_ONE_ID,
              name: 'Engineering',
              version_id: 'a'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }

      return jsonResponse({
        id: PLUGIN_ONE_ID,
        version_id: 'a'.repeat(64),
        url: 'https://downloads.example/engineering.tar.gz',
      });
    });

    const downloads = await fetchNotionPluginDownloads('test-token', {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
    });

    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.summary.description).toBe('');
  });

  it('retries a transient server error while fetching a plugin directory', async () => {
    let directoryAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === '/v1/ai/plugins') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: PLUGIN_ONE_ID,
              name: 'Engineering',
              version_id: 'a'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }

      directoryAttempts += 1;
      if (directoryAttempts === 1) {
        return jsonResponse(
          {
            object: 'error',
            status: 500,
            code: 'internal_server_error',
            message: 'Unexpected error occurred.',
          },
          500,
          { 'retry-after': '0' }
        );
      }

      return jsonResponse({
        id: PLUGIN_ONE_ID,
        version_id: 'a'.repeat(64),
        url: 'https://downloads.example/engineering.tar.gz',
      });
    });

    const downloads = await fetchNotionPluginDownloads('test-token', {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
    });

    expect(downloads).toHaveLength(1);
    expect(directoryAttempts).toBe(2);
  });

  it('filters non-UUID plugin IDs without requesting their directories', async () => {
    const warnings: string[] = [];
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      requestedUrls.push(url.toString());

      if (url.pathname === '/v1/ai/plugins') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: '>tO?',
              name: 'Company-wide',
              version_id: 'a'.repeat(64),
            },
            {
              id: '6be44900-5769-4e54-ba7e-a6411285f214',
              name: 'Engineering',
              version_id: 'b'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }

      if (url.pathname === '/v1/ai/plugins/%3EtO%3F') {
        throw new Error('non-UUID plugin IDs must not be requested');
      }

      return jsonResponse({
        id: '6be44900-5769-4e54-ba7e-a6411285f214',
        version_id: 'b'.repeat(64),
        url: 'https://downloads.example/engineering.tar.gz',
      });
    });

    const requestOptions = {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
      onWarning: (warning: string) => warnings.push(warning),
    };
    const downloads = await fetchNotionPluginDownloads('test-token', requestOptions);

    expect(downloads.map((download) => download.summary.name)).toEqual(['Engineering']);
    expect(warnings).toEqual([
      'Skipped Notion plugin "Company-wide" (>tO?): Notion returned a non-UUID plugin ID',
    ]);
    expect(requestedUrls).not.toContain('https://api.example/v1/ai/plugins/%3EtO%3F');
  });

  it('warns and continues when one UUID plugin directory times out', async () => {
    const warnings: string[] = [];
    const firstId = '04bc94c5-1a64-49c5-ac4c-5f603c1a0146';
    const secondId = '6be44900-5769-4e54-ba7e-a6411285f214';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());

      if (url.pathname === '/v1/ai/plugins') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: firstId,
              name: 'Engineering',
              version_id: 'a'.repeat(64),
            },
            {
              id: secondId,
              name: 'Docs',
              version_id: 'b'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }

      if (url.pathname === `/v1/ai/plugins/${firstId}`) {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }

      return jsonResponse({
        id: secondId,
        version_id: 'b'.repeat(64),
        url: 'https://downloads.example/docs.tar.gz',
      });
    });

    const requestOptions = {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
      onWarning: (warning: string) => warnings.push(warning),
    };
    const downloads = await fetchNotionPluginDownloads('test-token', requestOptions);

    expect(downloads.map((download) => download.summary.name)).toEqual(['Docs']);
    expect(warnings).toEqual([
      `Skipped Notion plugin "Engineering" (${firstId}): Notion API request failed: The operation was aborted due to timeout while fetching plugin "Engineering" (${firstId})`,
    ]);
  });

  it('paginates plugin summaries and fetches every signed directory URL', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const cursor = url.searchParams.get('start_cursor');

      if (url.pathname === '/v1/ai/plugins' && !cursor) {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: PLUGIN_ONE_ID,
              name: 'Engineering',
              description: 'Engineering workflows',
              version_id: 'a'.repeat(64),
            },
          ],
          next_cursor: 'next123',
          has_more: true,
          type: 'plugin',
        });
      }

      if (url.pathname === '/v1/ai/plugins' && cursor === 'next123') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: PLUGIN_TWO_ID,
              name: 'Finance',
              description: 'Finance workflows',
              version_id: 'b'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }

      if (url.pathname === `/v1/ai/plugins/${PLUGIN_ONE_ID}`) {
        return jsonResponse({
          id: PLUGIN_ONE_ID,
          version_id: 'a'.repeat(64),
          url: 'https://downloads.example/engineering.tar.gz',
        });
      }

      if (url.pathname === `/v1/ai/plugins/${PLUGIN_TWO_ID}`) {
        return jsonResponse({
          id: PLUGIN_TWO_ID,
          version_id: 'b'.repeat(64),
          url: 'https://downloads.example/finance.tar.gz',
        });
      }

      return jsonResponse({ message: 'not found' }, 404);
    });

    const downloads = await fetchNotionPluginDownloads('test-token', {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
    });

    expect(downloads).toHaveLength(2);
    expect(downloads.map((entry) => entry.summary.name)).toEqual(['Engineering', 'Finance']);
    expect(downloads.map((entry) => entry.directory.url)).toEqual([
      'https://downloads.example/engineering.tar.gz',
      'https://downloads.example/finance.tar.gz',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('groups discovered skills under the plugin name', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/ai/plugins') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: PLUGIN_ONE_ID,
              name: 'Document skills',
              description: 'Document workflows',
              version_id: 'a'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }
      return jsonResponse({
        id: PLUGIN_ONE_ID,
        version_id: 'a'.repeat(64),
        url: 'https://downloads.example/documents.tar.gz',
      });
    });

    const skills: Skill[] = [
      { name: 'pdf', description: 'Work with PDFs', path: '/tmp/notion-plugin/skills/pdf' },
      { name: 'docx', description: 'Work with DOCX', path: '/tmp/notion-plugin/skills/docx' },
    ];

    const loaded = await loadNotionPluginSkills('test-token', {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
      download: vi.fn(async () => ({
        rootDir: '/tmp/notion-plugin',
        tempDir: '/tmp/notion-plugin-download',
        kind: 'archive' as const,
      })),
      discover: vi.fn(async () => skills),
    });

    expect(loaded.pluginCount).toBe(1);
    expect(loaded.skills.map((skill) => skill.pluginName)).toEqual([
      'Document skills',
      'Document skills',
    ]);
  });

  it('warns and continues when one plugin archive cannot be downloaded', async () => {
    const warnings: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/ai/plugins') {
        return jsonResponse({
          object: 'list',
          results: [
            {
              id: PLUGIN_ONE_ID,
              name: 'notion-skills-updater',
              version_id: 'a'.repeat(64),
            },
            {
              id: PLUGIN_TWO_ID,
              name: 'Docs',
              version_id: 'b'.repeat(64),
            },
          ],
          next_cursor: null,
          has_more: false,
          type: 'plugin',
        });
      }

      const id = url.pathname.endsWith(PLUGIN_ONE_ID) ? PLUGIN_ONE_ID : PLUGIN_TWO_ID;
      return jsonResponse({
        id,
        version_id: id === PLUGIN_ONE_ID ? 'a'.repeat(64) : 'b'.repeat(64),
        url: `https://downloads.example/${id}.tar.gz`,
      });
    });
    const download = vi.fn(async (url: string) => {
      if (url.includes(PLUGIN_ONE_ID)) {
        throw new Error(
          'Download is larger than 52428800 bytes. Set SKILLS_DOWNLOAD_MAX_BYTES to override.'
        );
      }
      return {
        rootDir: '/tmp/notion-docs',
        tempDir: '/tmp/notion-docs-download',
        kind: 'archive' as const,
      };
    });

    const loaded = await loadNotionPluginSkills('test-token', {
      fetchImpl: fetchImpl as NotionFetch,
      apiBaseUrl: 'https://api.example',
      requestIntervalMs: 0,
      download,
      discover: vi.fn(async () => [
        { name: 'docs', description: 'Work with docs', path: '/tmp/notion-docs/skills/docs' },
      ]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(loaded.pluginCount).toBe(1);
    expect(loaded.skills.map((skill) => skill.name)).toEqual(['docs']);
    expect(warnings).toEqual([
      `Skipped Notion plugin "notion-skills-updater" (${PLUGIN_ONE_ID}): Download is larger than 52428800 bytes. Set SKILLS_DOWNLOAD_MAX_BYTES to override.`,
    ]);
  });

  it('surfaces structured Notion API errors without exposing credentials', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          object: 'error',
          status: 403,
          code: 'restricted_resource',
          message: 'Workspace is not enabled for the alpha',
        },
        403
      )
    );

    await expect(
      fetchNotionPluginDownloads('super-secret-token', {
        fetchImpl: fetchImpl as NotionFetch,
        apiBaseUrl: 'https://api.example',
        requestIntervalMs: 0,
      })
    ).rejects.toThrow(
      'Notion API request failed (403 restricted_resource): Workspace is not enabled for the alpha'
    );

    await expect(
      fetchNotionPluginDownloads('super-secret-token', {
        fetchImpl: fetchImpl as NotionFetch,
        apiBaseUrl: 'https://api.example',
        requestIntervalMs: 0,
      })
    ).rejects.not.toThrow('super-secret-token');
  });
});
