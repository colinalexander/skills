import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushTelemetry, setVersion, trackPackInstall } from '../src/telemetry.ts';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DISABLE_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
});

describe('trackPackInstall', () => {
  it('reports one completed pack install to the pack callback', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    setVersion('1.5.16');

    trackPackInstall({
      packUrl: 'https://skills.sh/p/frontend-pack-A1b2C3d4',
      packId: 'frontend-pack-A1b2C3d4',
      receipt: 'receipt-token-123456',
      agents: ['codex', 'claude-code', 'codex'],
      global: true,
      installedSkillCount: 2,
    });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe('https://skills.sh/api/p/frontend-pack-A1b2C3d4/install');
    expect(options).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      receipt: 'receipt-token-123456',
      agents: ['claude-code', 'codex'],
      global: true,
      installed_skill_count: 2,
      cli_version: '1.5.16',
    });
  });

  it('does not report an install with no successful skills', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    trackPackInstall({
      packUrl: 'https://skills.sh/p/frontend-pack-A1b2C3d4',
      packId: 'frontend-pack-A1b2C3d4',
      receipt: 'receipt-token-123456',
      agents: ['codex'],
      global: false,
      installedSkillCount: 0,
    });
    await flushTelemetry();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
