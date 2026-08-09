import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./auth-store.ts', () => ({ getToken: vi.fn() }));
vi.mock('./login.ts', () => ({ runLogin: vi.fn() }));
vi.mock('./blob.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./blob.ts')>();
  return { ...actual, resolvePrivateInstall: vi.fn() };
});

import { tryPrivateInstall } from './add.ts';
import * as blob from './blob.ts';
import * as authStore from './auth-store.ts';
import * as login from './login.ts';

const spinner = { start: () => {}, stop: () => {} } as any;

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

describe('tryPrivateInstall', () => {
  const origTTY = process.stdin.isTTY;
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it('returns skills with an empty tree on ok', async () => {
    vi.mocked(authStore.getToken).mockReturnValue({ token: 't', source: 'file' });
    vi.mocked(blob.resolvePrivateInstall).mockResolvedValue({
      status: 'ok',
      skills: [{ name: 's' } as any],
    });
    const res = await tryPrivateInstall('a/b', { ref: 'main' }, {} as any, spinner);
    expect(res?.skills).toHaveLength(1);
    expect(res?.tree).toEqual({ sha: '', branch: 'main', tree: [] });
  });

  it('returns null on not-found', async () => {
    vi.mocked(authStore.getToken).mockReturnValue(null);
    vi.mocked(blob.resolvePrivateInstall).mockResolvedValue({ status: 'not-found' });
    expect(await tryPrivateInstall('a/b', {}, {} as any, spinner)).toBeNull();
  });

  it('returns null on error', async () => {
    vi.mocked(authStore.getToken).mockReturnValue({ token: 't', source: 'file' });
    vi.mocked(blob.resolvePrivateInstall).mockResolvedValue({ status: 'error' });
    expect(await tryPrivateInstall('a/b', {}, {} as any, spinner)).toBeNull();
  });

  it('exits on forbidden', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('EXIT');
    });
    vi.mocked(authStore.getToken).mockReturnValue({ token: 't', source: 'file' });
    vi.mocked(blob.resolvePrivateInstall).mockResolvedValue({ status: 'forbidden' });
    await expect(tryPrivateInstall('a/b', {}, {} as any, spinner)).rejects.toThrow('EXIT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits on unauthorized when non-interactive', async () => {
    setTTY(false);
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('EXIT');
    });
    vi.mocked(authStore.getToken).mockReturnValue(null);
    vi.mocked(blob.resolvePrivateInstall).mockResolvedValue({ status: 'unauthorized' });
    await expect(tryPrivateInstall('a/b', {}, { yes: true } as any, spinner)).rejects.toThrow(
      'EXIT'
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(login.runLogin).not.toHaveBeenCalled();
  });

  it('logs in then retries once and succeeds (interactive)', async () => {
    setTTY(true);
    vi.mocked(authStore.getToken)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ token: 'new', source: 'file' });
    vi.mocked(login.runLogin).mockResolvedValue();
    vi.mocked(blob.resolvePrivateInstall)
      .mockResolvedValueOnce({ status: 'unauthorized' })
      .mockResolvedValueOnce({ status: 'ok', skills: [{ name: 's' } as any] });
    const res = await tryPrivateInstall('a/b', {}, {} as any, spinner);
    expect(login.runLogin).toHaveBeenCalledOnce();
    expect(res?.skills).toHaveLength(1);
  });

  it('exits if still unauthorized after login retry', async () => {
    setTTY(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('EXIT');
    });
    vi.mocked(authStore.getToken).mockReturnValue({ token: 't', source: 'file' });
    vi.mocked(login.runLogin).mockResolvedValue();
    vi.mocked(blob.resolvePrivateInstall).mockResolvedValue({ status: 'unauthorized' });
    await expect(tryPrivateInstall('a/b', {}, {} as any, spinner)).rejects.toThrow('EXIT');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
