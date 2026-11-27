/**
 * 类型颜色：两套取值
 *
 * 资产类型在数据库里存的是「浅底色」（#ddf4ff 这类，给白底标签用）。
 * 直接拿它当深色界面的状态灯，所有灯都会接近白色，等于没有区分度。
 * 模板 demo 里的灯和类型列用的是一组高饱和亮色，所以这里显式维护一份，
 * 自定义类型（ct_*）则由用户选的底色推导出亮色 / 深色两个版本。
 */

/** 深色界面：高饱和亮色（灯 + 类型列文字） */
const GLOW: Record<string, string> = {
  project: '#4be1c8',
  server: '#5eb1ff',
  ssh_key: '#3ddc97',
  cloud_account: '#b18cff',
  oss: '#ff8ad1',
  baota: '#ffb224',
  mcp: '#7ad3ff',
  api_key: '#f5e15c',
  login_account: '#ff8a7a',
  email_account: '#9aa0a8',
  note: '#8b929c',
};

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 从任意底色推导：饱和度拉到能发光，亮度夹在中间档 */
function deriveGlow(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#9aa0a8';
  const [h, s, l] = rgbToHsl(...rgb);
  // 近灰（s 太小）没法提饱和，直接给中性亮灰
  if (s < 0.08) return '#9aa0a8';
  return hslToHex(h, Math.min(1, Math.max(s, 0.66)), Math.min(0.68, Math.max(l, 0.52)));
}

/** 浅色界面：同色系压暗，保证白底上能读 */
function deriveInk(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#5b5f66';
  const [h, s, l] = rgbToHsl(...rgb);
  if (s < 0.08) return '#5b5f66';
  return hslToHex(h, Math.min(1, Math.max(s, 0.55)), Math.min(0.44, Math.max(l, 0.3)));
}

/**
 * 取类型的界面色。
 * @param type 类型 key
 * @param base 数据库里的浅底色（自定义类型才有意义）
 * @param dark 当前是否深色模板
 */
export function typeUiColor(type: string, base: string | undefined, dark: boolean): string {
  if (dark) return GLOW[type] || deriveGlow(base || '#9aa0a8');
  // 浅色下列不要用「浅底色」，那样白底上等于没有颜色
  return deriveInk(GLOW[type] || base || '#9aa0a8');
}

/** 灯/色点用：深色下高亮发光，浅色下压暗 */
export function typeLedColor(type: string, base: string | undefined, dark: boolean): string {
  return typeUiColor(type, base, dark);
}
