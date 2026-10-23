import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, type Dispatcher } from 'undici';
import { fetchBangumi } from './bangumi-request';
import { checkUpstreamAllowed, checkLiveUrlAllowed } from './ssrf';

vi.mock('./ssrf', () => ({ checkUpstreamAllowed: vi.fn(), checkLiveUrlAllowed: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BANGUMI_PROXY_URL', '');
  vi.mocked(checkUpstreamAllowed).mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Bangumi 专用网络路径', () => {
  it('未配置专用代理时保持直连，不读取HTTP_PROXY或改变全局dispatcher', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:12345');
    const global = getGlobalDispatcher();
    await fetchBangumi('https://api.bgm.tv/calendar');
    expect(vi.mocked(fetch).mock.calls[0][1]).not.toHaveProperty('dispatcher');
    expect(getGlobalDispatcher()).toBe(global);
  });

  it('显式代理只作为本次请求dispatcher传入，保留POST内容、超时信号和逐跳手动跟随', async () => {
    vi.stubEnv('BANGUMI_PROXY_URL', 'http://127.0.0.1:7890');
    const global = getGlobalDispatcher();
    await fetchBangumi('https://api.bgm.tv/v0/search/subjects', { method: 'POST', body: '{"keyword":""}', timeoutMs: 2000 });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit & { dispatcher: Dispatcher };
    expect(init).toMatchObject({ method: 'POST', body: '{"keyword":""}', redirect: 'manual' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.dispatcher).toBeDefined();
    expect(getGlobalDispatcher()).toBe(global);
    expect(checkUpstreamAllowed).toHaveBeenCalledWith('https://api.bgm.tv/v0/search/subjects');
  });

  it('拒绝非Bangumi地址、非HTTP代理和含路径的错误配置', async () => {
    await expect(fetchBangumi('https://other.example/v0/subjects')).rejects.toThrow('地址无效');
    vi.stubEnv('BANGUMI_PROXY_URL', 'socks5://127.0.0.1:1080');
    await expect(fetchBangumi('https://api.bgm.tv/calendar')).rejects.toThrow('仅支持');
    vi.stubEnv('BANGUMI_PROXY_URL', 'http://127.0.0.1:7890/api');
    await expect(fetchBangumi('https://api.bgm.tv/calendar')).rejects.toThrow('仅支持');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('配置代理也保留内网重定向阻断，不允许调用者绕过安全跳转链', async () => {
    vi.stubEnv('BANGUMI_PROXY_URL', 'http://127.0.0.1:7890');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }));
    vi.mocked(checkUpstreamAllowed).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'private' });
    await expect(fetchBangumi('https://api.bgm.tv/calendar', { safeRedirects: false, allowPrivate: true })).rejects.toThrow('private');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(checkUpstreamAllowed).toHaveBeenNthCalledWith(2, 'http://127.0.0.1/private');
    expect(checkLiveUrlAllowed).not.toHaveBeenCalled();
  });

  it('专用dispatcher拒绝把后续其他公网域名交给本地代理', async () => {
    vi.stubEnv('BANGUMI_PROXY_URL', 'http://127.0.0.1:7890');
    await fetchBangumi('https://api.bgm.tv/calendar');
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit & { dispatcher: Dispatcher };
    expect(() => init.dispatcher.dispatch({ origin: 'https://other.example', path: '/', method: 'GET' }, {})).toThrow('超出允许范围');
  });
});
