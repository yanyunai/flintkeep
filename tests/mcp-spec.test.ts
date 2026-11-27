import { describe, expect, it } from 'vitest';
import { MCP_TOOL_GUIDE, TOOL_SPECS, TOOL_SPECS_V2, V2_TOOL_NAMES, posixPath } from '../src/core/mcp-meta';

/**
 * MCP 工具面元数据：v2 九个入口、指南单一来源、老工具默认不下发。
 * 这些断言成本极低，但能挡住「新增一个老工具顺手塞进 guide」这类破坏体积预算的改动。
 */
const V2 = ['find', 'show', 'connect', 'manage', 'run_project', 'sync_whitelist', 'usage', 'note', 'backup'];

describe('v2 工具面', () => {
  it('恰好九个入口，名称固定', () => {
    expect(TOOL_SPECS_V2.length).toBe(9);
    expect([...V2_TOOL_NAMES].sort()).toEqual([...V2].sort());
  });

  it('每个入口都有 object 型 inputSchema 与非空描述', () => {
    for (const s of TOOL_SPECS_V2) {
      expect(s.inputSchema.type).toBe('object');
      expect(s.description.length > 10).toBe(true);
    }
  });

  it('指南由 v2 定义派生（单一来源），顺序一一对应', () => {
    expect(MCP_TOOL_GUIDE.length).toBe(TOOL_SPECS_V2.length);
    MCP_TOOL_GUIDE.forEach((g, i) => {
      expect(g.name).toBe(TOOL_SPECS_V2[i].name);
      expect(!!g.desc).toBe(true);
    });
  });

  it('老工具不进指南（默认不下发，需 full 档）', () => {
    const guideNames = new Set(MCP_TOOL_GUIDE.map((g) => g.name));
    for (const legacy of ['list_assets', 'search_assets', 'get_asset', 'add_asset', 'request_ssh_access']) {
      expect(guideNames.has(legacy)).toBe(false);
    }
    // 老工具本身仍然存在（保留可调用，保证旧配置不炸）
    const legacyNames = new Set(TOOL_SPECS.map((s) => s.name));
    expect(legacyNames.has('list_assets')).toBe(true);
    expect(legacyNames.size >= 20).toBe(true);
  });

  it('v2 与老工具不重名（避免同名两套语义）', () => {
    const legacy = new Set(TOOL_SPECS.map((s) => s.name));
    for (const name of V2) expect(legacy.has(name)).toBe(false);
  });

  it('posixPath 统一成 / 分隔（跨平台配置片段用）', () => {
    expect(posixPath('a\\b\\c')).toBe('a/b/c');
    expect(posixPath('/x/y')).toBe('/x/y');
  });
});