/**
 * 公网 IP 探测：并发请求多个外网源 + 正则提取 + 校验去重。
 * 探测源沿用 easy_whitelist（国内可用：ifconfig.me / cip.cc / tool.lu / ip.sb），
 * 保持与其一致的行为，便于对照验证。
 */

const UA_CURL = 'curl/8.6.0';
const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export interface DetectSource {
  url: string;
  pattern: RegExp;
  ua: string;
}

export const DEFAULT_SOURCES: DetectSource[] = [
  { url: 'https://ifconfig.me', pattern: /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/, ua: UA_CURL },
  { url: 'https://cip.cc', pattern: /IP\s*:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/, ua: UA_CHROME },
  { url: 'https://tool.lu/ip/', pattern: /你的外网IP地址是\s*：\s*?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/, ua: UA_CHROME },
  { url: 'http://ip.sb/', pattern: /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/, ua: UA_CURL },
];

const IPV4_EXACT = /^((?:[1-9]?\d|1\d\d|2[0-4]\d|25[0-5])\.){3}(?:[1-9]?\d|1\d\d|2[0-4]\d|25[0-5])$/;

/** 严格校验 IPv4（拒绝 999.1.1.1 这类非法段） */
export function isValidIpv4(ip: unknown): boolean {
  return IPV4_EXACT.test(String(ip ?? '').trim());
}

/** 从响应正文里按正则提取第一个 IP；提取不到返回 null */
export function extractIp(text: string, pattern: RegExp = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/): string | null {
  const m = String(text ?? '').match(pattern);
  if (!m) return null;
  return m[1] ?? m[0] ?? null;
}

/** 去重并剔除非法项，保留首次出现顺序 */
export function dedupIps(list: string[]): string[] {
  return Array.from(new Set((list || []).filter(isValidIpv4)));
}

export interface DetectOptions {
  timeoutMs?: number;
  sources?: DetectSource[];
  /** 可注入的 fetch 实现，便于离线单测 */
  fetcher?: (url: string, init?: any) => Promise<any>;
}

/** 并发探测本机公网 IP，返回去重后的合法 IP 列表（可能为空） */
export async function detectPublicIp(opts: DetectOptions = {}): Promise<string[]> {
  const sources = opts.sources || DEFAULT_SOURCES;
  const fetcher = opts.fetcher || ((globalThis as any).fetch as (u: string, i?: any) => Promise<any>);
  const timeoutMs = opts.timeoutMs ?? 5000;

  const results = await Promise.all(
    sources.map(async (s): Promise<string | null> => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetcher(s.url, { headers: { 'user-agent': s.ua }, signal: ctrl.signal });
          const text = typeof res?.text === 'function' ? await res.text() : String(res ?? '');
          const ip = extractIp(text, s.pattern);
          return isValidIpv4(ip) ? (ip as string) : null;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return null; // 单个源失败不影响其它源
      }
    })
  );

  return dedupIps(results.filter((x): x is string => !!x));
}
