/**
 * 版本号比较（只处理项目真实会用到的形态）。
 *
 * 为什么自己写：更新检查只需要「比较两串版本号谁新」，为一个函数引入 semver 依赖
 * 不值当——那会给公开仓的依赖面再加一个包。这里覆盖 3 种形态：
 *   `1.2.3`、`v1.2.3`、`1.2.3-beta.1`（预发布版比同号正式版旧）。
 *
 * 边界：解析不出数字就返回 0（按「无法比较」处理），调用方据此保持「已是最新」的
 * 保守结论，绝不因为解析失败去提示用户升级。
 */

/** 取出主版本数字段；解析失败返回空数组 */
export function normalizeVersion(input: string): number[] {
  const m = String(input ?? '')
    .trim()
    .match(/^v?(\d+(?:\.\d+)*)/i);
  if (!m) return [];
  return m[1].split('.').map((n) => Number(n));
}

/** 是否带预发布后缀（-alpha / -beta / -rc / -pre / -dev） */
export function isPreRelease(input: string): boolean {
  return /-(alpha|beta|rc|pre|dev)\b/i.test(String(input ?? ''));
}

/**
 * 比较版本：a 比 b 新返回 1，旧返回 -1，相同或无法比较返回 0。
 * 分段逐位比，缺的位按 0 补齐（1.2 == 1.2.0）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a);
  const pb = normalizeVersion(b);
  if (!pa.length || !pb.length) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 号相同：预发布版更旧（1.2.3-beta.1 < 1.2.3）
  const preA = isPreRelease(a);
  const preB = isPreRelease(b);
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

/** latest 是否比 current 新 */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/** 把 tag 归一成展示用版本号（`v0.1.1` → `0.1.1`，无 v 前缀时补上 v 前缀的都可接受） */
export function tagToVersion(tag: string): string {
  return String(tag ?? '')
    .trim()
    .replace(/^v/i, '');
}
