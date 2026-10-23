import { ProxyAgent, type Dispatcher } from 'undici';
import { fetchUpstream, type FetchOptions } from './fetch-utils';

const BANGUMI_ORIGIN = 'https://api.bgm.tv';
let proxyUrl: string | undefined;
let proxyAgent: BangumiProxyAgent | undefined;

/** 即便上游返回重定向，也不把此专用代理用于其他域名。 */
class BangumiProxyAgent extends ProxyAgent {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (new URL(String(options.origin)).origin !== BANGUMI_ORIGIN) {
      throw new Error('动漫目录重定向超出允许范围');
    }
    return super.dispatch(options, handler);
  }
}

function configuredProxy(): BangumiProxyAgent | undefined {
  const configured = process.env.BANGUMI_PROXY_URL?.trim();
  if (!configured) return undefined;
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new Error('BANGUMI_PROXY_URL 配置无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('BANGUMI_PROXY_URL 仅支持 HTTP/HTTPS 代理地址');
  }
  if (!proxyAgent || proxyUrl !== configured) {
    const previous = proxyAgent;
    proxyAgent = new BangumiProxyAgent(configured);
    proxyUrl = configured;
    if (previous) void previous.close().catch(() => {});
  }
  return proxyAgent;
}

/**
 * 仅 Bangumi 请求可显式走部署者配置的代理；不读取通用代理变量，也不改全局 dispatcher。
 * 传输仍经 fetchUpstream 的逐跳公网校验，代理地址本身只来自服务端环境配置。
 */
export async function fetchBangumi(url: string, options: FetchOptions = {}): Promise<Response> {
  const target = new URL(url);
  if (target.origin !== BANGUMI_ORIGIN || target.username || target.password) throw new Error('动漫目录地址无效');
  const dispatcher = configuredProxy();
  const requestOptions: FetchOptions & { dispatcher?: Dispatcher } = {
    ...options,
    safeRedirects: true,
    allowPrivate: false,
    ...(dispatcher ? { dispatcher } : {}),
  };
  return fetchUpstream(url, requestOptions);
}
