/**
 * 云账号的「中文名 → 用量适配器 id」映射。
 *
 * 单独成文件是因为它被两处共用：路由模块（按账号拉用量）与启动文件里的
 * 定时探测（`startAiProbeTimer`）。留在 `server.ts` 里会让路由反向依赖启动文件。
 */
export const AI_PROVIDER_MAP: Record<string, string> = {
  阿里云: 'aliyun',
  腾讯云: 'tencent',
  火山引擎: 'volcengine',
};
