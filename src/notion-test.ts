import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDir } from './git.ts';
import { downloadSource, type DownloadedSource } from './download-source.ts';
import { discoverSkills, filterSkills, getSkillDisplayName } from './skills.ts';
import { sanitizeMetadata, stripTerminalEscapes } from './sanitize.ts';
import { searchMultiselect } from './prompts/search-multiselect.ts';
import type { Skill } from './types.ts';

export const NOTION_TEST_SOURCE = 'notion-test';

const DEFAULT_NOTION_API_BASE_URL = 'https://api.notion.com';
const NOTION_API_VERSION = '2026-03-11';
const NOTION_REQUEST_INTERVAL_MS = 350;
const NOTION_LIST_REQUEST_TIMEOUT_MS = 30_000;
const NOTION_DETAIL_REQUEST_TIMEOUT_MS = 10_000;
const NOTION_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const NOTION_EXTRACT_MAX_BYTES = 100 * 1024 * 1024;
const NOTION_EXTRACT_MAX_FILES = 5000;
const MAX_NOTION_REQUEST_RETRIES = 1;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotionPluginSummary {
  id: string;
  name: string;
  description: string;
  version_id: string;
}

interface NotionPluginListResponse {
  object: 'list';
  results: NotionPluginSummary[];
  next_cursor: string | null;
  has_more: boolean;
  type: 'plugin';
}

export interface NotionPluginDirectory {
  id: string;
  version_id: string;
  url: string;
}

export interface NotionPluginDownload {
  summary: NotionPluginSummary;
  directory: NotionPluginDirectory;
}

export interface LoadedNotionPlugins {
  skills: Skill[];
  pluginCount: number;
  tempDirs: string[];
}

export type NotionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface NotionApiOptions {
  fetchImpl?: NotionFetch;
  apiBaseUrl?: string;
  requestIntervalMs?: number;
  onWarning?: (warning: string) => void;
}

interface NotionLoaderOptions extends NotionApiOptions {
  download?: (url: string) => Promise<DownloadedSource>;
  discover?: typeof discoverSkills;
}

export interface NotionTestSelectorOptions {
  yes?: boolean;
  list?: boolean;
  skill?: string[];
}

interface NotionApiErrorBody {
  code?: string;
  message?: string;
}

class NotionApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'NotionApiRequestError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function debugNotion(message: string): void {
  if (process.env.SKILLS_DEBUG === '1') {
    console.error(`[notion-test] ${message}`);
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Notion Agent Plugins response is missing ${field}`);
  }
  return value;
}

function optionalMetadata(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Notion Agent Plugins response has an invalid ${field}`);
  }
  return sanitizeMetadata(value);
}

function parsePluginSummary(value: unknown): NotionPluginSummary {
  if (!isRecord(value)) {
    throw new Error('Notion Agent Plugins response contains an invalid plugin');
  }

  return {
    id: assertString(value.id, 'plugin.id'),
    name: sanitizeMetadata(assertString(value.name, 'plugin.name')),
    description: optionalMetadata(value.description, 'plugin.description'),
    version_id: assertString(value.version_id, 'plugin.version_id'),
  };
}

function parsePluginList(value: unknown): NotionPluginListResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('Notion Agent Plugins list response is invalid');
  }

  if (typeof value.has_more !== 'boolean') {
    throw new Error('Notion Agent Plugins list response is missing has_more');
  }

  const nextCursor = value.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('Notion Agent Plugins list response has an invalid next_cursor');
  }

  return {
    object: 'list',
    results: value.results.map(parsePluginSummary),
    next_cursor: nextCursor,
    has_more: value.has_more,
    type: 'plugin',
  };
}

function parsePluginDirectory(value: unknown): NotionPluginDirectory {
  if (!isRecord(value)) {
    throw new Error('Notion Agent Plugins directory response is invalid');
  }

  return {
    id: assertString(value.id, 'plugin directory id'),
    version_id: assertString(value.version_id, 'plugin directory version_id'),
    url: assertString(value.url, 'plugin directory url'),
  };
}

async function readErrorBody(response: Response): Promise<NotionApiErrorBody> {
  try {
    const value = (await response.json()) as unknown;
    if (!isRecord(value)) return {};
    return {
      code: typeof value.code === 'string' ? value.code : undefined,
      message: typeof value.message === 'string' ? value.message : undefined,
    };
  } catch {
    return {};
  }
}

function getRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 10_000);
}

async function fetchNotionJson(
  url: URL,
  token: string,
  fetchImpl: NotionFetch,
  context: string,
  timeoutMs = NOTION_LIST_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_NOTION_REQUEST_RETRIES; attempt += 1) {
    debugNotion(
      `GET ${url.toString()} — ${context} (attempt ${attempt + 1}/${MAX_NOTION_REQUEST_RETRIES + 1}, timeout ${timeoutMs}ms)`
    );
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_API_VERSION,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail =
        error instanceof Error && error.message ? `: ${stripTerminalEscapes(error.message)}` : '';
      throw new NotionApiRequestError(0, `Notion API request failed${detail} while ${context}`);
    }
    debugNotion(`${response.status} ${response.statusText || 'response'} — ${context}`);

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_NOTION_REQUEST_RETRIES) {
      const retryDelay = getRetryDelay(response, attempt);
      debugNotion(`retrying ${context} in ${retryDelay}ms`);
      await delay(retryDelay);
      continue;
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      const code = body.code ? ` ${body.code}` : '';
      const message = body.message ? `: ${stripTerminalEscapes(body.message)}` : '';
      throw new NotionApiRequestError(
        response.status,
        `Notion API request failed (${response.status}${code})${message} while ${context}`
      );
    }

    return response.json() as Promise<unknown>;
  }

  throw new Error(`Notion API request failed after retries while ${context}`);
}

export async function fetchNotionPluginDownloads(
  token: string,
  options: NotionApiOptions = {}
): Promise<NotionPluginDownload[]> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new Error('NOTION_API_TOKEN is empty');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_NOTION_API_BASE_URL;
  const requestIntervalMs = options.requestIntervalMs ?? NOTION_REQUEST_INTERVAL_MS;
  const summaries: NotionPluginSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pageNumber = 1;

  do {
    const url = new URL('/v1/ai/plugins', apiBaseUrl);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);

    const page = parsePluginList(
      await fetchNotionJson(url, normalizedToken, fetchImpl, `listing plugins (page ${pageNumber})`)
    );
    summaries.push(...page.results);
    debugNotion(`received ${page.results.length} plugin summaries on page ${pageNumber}`);

    if (!page.has_more) {
      cursor = null;
      break;
    }

    if (!page.next_cursor || seenCursors.has(page.next_cursor)) {
      throw new Error('Notion Agent Plugins pagination returned an invalid cursor');
    }
    cursor = page.next_cursor;
    seenCursors.add(cursor);
    pageNumber += 1;

    if (requestIntervalMs > 0) await delay(requestIntervalMs);
  } while (cursor);

  const downloads: NotionPluginDownload[] = [];
  for (const [index, summary] of summaries.entries()) {
    const displayId = sanitizeMetadata(summary.id);
    const displayVersionId = sanitizeMetadata(summary.version_id);
    debugNotion(
      `plugin ${index + 1}/${summaries.length}: name=${JSON.stringify(summary.name)} id=${JSON.stringify(displayId)} version_id=${JSON.stringify(displayVersionId)}`
    );

    if (!CANONICAL_UUID_PATTERN.test(summary.id)) {
      const warning = `Skipped Notion plugin ${JSON.stringify(summary.name)} (${displayId}): Notion returned a non-UUID plugin ID`;
      debugNotion(warning);
      options.onWarning?.(warning);
      continue;
    }

    if (requestIntervalMs > 0) await delay(requestIntervalMs);

    const url = new URL(`/v1/ai/plugins/${encodeURIComponent(summary.id)}`, apiBaseUrl);
    const context = `fetching plugin ${JSON.stringify(summary.name)} (${displayId})`;
    let directory: NotionPluginDirectory;
    try {
      directory = parsePluginDirectory(
        await fetchNotionJson(
          url,
          normalizedToken,
          fetchImpl,
          context,
          NOTION_DETAIL_REQUEST_TIMEOUT_MS
        )
      );
    } catch (error) {
      if (error instanceof NotionApiRequestError && (error.status === 0 || error.status >= 500)) {
        const warning = `Skipped Notion plugin ${JSON.stringify(summary.name)} (${displayId}): ${error.message}`;
        debugNotion(warning);
        options.onWarning?.(warning);
        continue;
      }
      throw error;
    }

    if (directory.id !== summary.id || directory.version_id !== summary.version_id) {
      throw new Error(`Notion plugin ${summary.name} changed while it was being downloaded`);
    }

    downloads.push({ summary, directory });
  }

  return downloads;
}

async function readPluginName(rootDir: string, fallback: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(rootDir, 'plugin.json'), 'utf-8')) as unknown;
    if (isRecord(manifest) && typeof manifest.name === 'string' && manifest.name.length > 0) {
      return sanitizeMetadata(manifest.name);
    }
  } catch {
    // The API summary remains a useful display name if the prototype manifest is incomplete.
  }
  return fallback;
}

export async function loadNotionPluginSkills(
  token: string,
  options: NotionLoaderOptions = {}
): Promise<LoadedNotionPlugins> {
  const downloads = await fetchNotionPluginDownloads(token, options);
  const download =
    options.download ??
    ((url: string) =>
      downloadSource(url, {
        downloadMaxBytes: NOTION_DOWNLOAD_MAX_BYTES,
        extractMaxBytes: NOTION_EXTRACT_MAX_BYTES,
        extractMaxFiles: NOTION_EXTRACT_MAX_FILES,
      }));
  const discover = options.discover ?? discoverSkills;
  const tempDirs: string[] = [];
  const skills: Skill[] = [];
  let pluginCount = 0;

  try {
    for (const plugin of downloads) {
      let pluginTempDir: string | undefined;
      const displayId = sanitizeMetadata(plugin.summary.id);
      try {
        debugNotion(
          `downloading archive for ${JSON.stringify(plugin.summary.name)} (${displayId})`
        );
        const downloaded = await download(plugin.directory.url);
        pluginTempDir = downloaded.tempDir;
        tempDirs.push(downloaded.tempDir);

        debugNotion(`discovering skills for ${JSON.stringify(plugin.summary.name)} (${displayId})`);
        const pluginName = await readPluginName(downloaded.rootDir, plugin.summary.name);
        const pluginSkills = await discover(downloaded.rootDir);
        for (const skill of pluginSkills) {
          skill.pluginName = pluginName;
          skills.push(skill);
        }
        pluginCount += 1;
        debugNotion(
          `discovered ${pluginSkills.length} skill${pluginSkills.length === 1 ? '' : 's'} for ${JSON.stringify(pluginName)}`
        );
      } catch (error) {
        if (pluginTempDir) {
          await cleanupTempDir(pluginTempDir).catch(() => {});
          const tempDirIndex = tempDirs.indexOf(pluginTempDir);
          if (tempDirIndex >= 0) tempDirs.splice(tempDirIndex, 1);
        }
        const detail =
          error instanceof Error ? sanitizeMetadata(error.message) : 'Unknown archive error';
        const warning = `Skipped Notion plugin ${JSON.stringify(plugin.summary.name)} (${displayId}): ${detail}`;
        debugNotion(warning);
        options.onWarning?.(warning);
      }
    }

    return { skills, pluginCount, tempDirs };
  } catch (error) {
    await Promise.all(tempDirs.map((dir) => cleanupTempDir(dir).catch(() => {})));
    throw error;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function printAvailableSkills(skills: Skill[]): void {
  const groups = new Map<string, Skill[]>();
  for (const skill of skills) {
    const group = skill.pluginName ?? 'Other';
    const entries = groups.get(group) ?? [];
    entries.push(skill);
    groups.set(group, entries);
  }

  console.log();
  p.log.step(pc.bold('Available Skills'));
  for (const [group, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(pc.bold(titleCase(group)));
    for (const skill of entries) {
      p.log.message(`  ${pc.cyan(getSkillDisplayName(skill))}`);
      p.log.message(`    ${pc.dim(skill.description)}`);
    }
    console.log();
  }
}

export async function runNotionTestSelector(
  options: NotionTestSelectorOptions = {}
): Promise<void> {
  const token = process.env.NOTION_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'notion-test requires NOTION_API_TOKEN. Export the token in your shell, then retry.'
    );
  }

  const spinner = p.spinner();
  spinner.start('Fetching plugins from Notion…');

  let loaded: LoadedNotionPlugins | null = null;
  let spinnerActive = true;
  const warnings: string[] = [];
  try {
    loaded = await loadNotionPluginSkills(token, {
      onWarning: (warning) => warnings.push(warning),
    });
    const { skills, pluginCount } = loaded;

    if (skills.length === 0) {
      throw new Error('Notion returned no valid skills');
    }

    spinner.stop(
      `Found ${pc.green(skills.length)} skill${skills.length === 1 ? '' : 's'} in ${pluginCount} plugin${pluginCount === 1 ? '' : 's'}`
    );
    spinnerActive = false;

    for (const warning of warnings) {
      p.log.warn(pc.yellow(warning));
    }

    if (options.list) {
      printAvailableSkills(skills);
      p.outro(pc.dim('Notion prototype only — no skills were installed.'));
      return;
    }

    let selectedSkills: Skill[];
    if (options.skill && options.skill.length > 0) {
      selectedSkills = options.skill.includes('*') ? skills : filterSkills(skills, options.skill);
      if (selectedSkills.length === 0) {
        throw new Error(`No matching skills found for: ${options.skill.join(', ')}`);
      }
    } else if (options.yes || !process.stdin.isTTY) {
      selectedSkills = skills;
    } else {
      const sortedSkills = [...skills].sort((a, b) => {
        const groupComparison = (a.pluginName ?? '').localeCompare(b.pluginName ?? '');
        return groupComparison || getSkillDisplayName(a).localeCompare(getSkillDisplayName(b));
      });

      const selected = await searchMultiselect({
        message: `Select skills to install ${pc.dim('(space to toggle)')}`,
        items: sortedSkills.map((skill) => ({
          value: skill,
          label: getSkillDisplayName(skill),
          group: titleCase(skill.pluginName ?? 'Other'),
          detail: skill.description,
        })),
        required: true,
        maxVisible: 20,
        searchable: false,
        showDetail: true,
        showSelectedSummary: false,
        selectGroups: true,
      });

      if (typeof selected === 'symbol') {
        p.cancel('Selection cancelled');
        return;
      }
      selectedSkills = selected as Skill[];
    }

    const selectedLines = selectedSkills.map(
      (skill) =>
        `${pc.cyan(getSkillDisplayName(skill))} ${pc.dim(`(${skill.pluginName ?? 'Other'})`)}`
    );
    p.note(selectedLines.join('\n'), `Selected ${selectedSkills.length} skills`);
    p.outro(pc.dim('Notion prototype only — no skills were installed.'));
  } catch (error) {
    if (spinnerActive) spinner.stop(pc.red('Failed to load Notion plugins'));
    throw error;
  } finally {
    if (loaded) {
      await Promise.all(loaded.tempDirs.map((dir) => cleanupTempDir(dir).catch(() => {})));
    }
  }
}
