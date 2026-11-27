/**
 * 数据目录解析（CLI / MCP / 桌面端共用）。
 *
 * 为什么单独抽出来：三个入口过去各写各的 —— CLI 只认 `FK_DATA_DIR`，桌面端与 MCP 只认
 * `VAULT_DATA_DIR`。用户按一种文档设置了变量，另一半进程就指向另一个目录，
 * 表现成「库是空的」或「口令不对」，而不是报配置错误，排查成本很高。
 *
 * 优先级：显式参数 > VAULT_DATA_DIR > FK_DATA_DIR > 各入口自己的默认值。
 * `VAULT_DATA_DIR` 在前：它是 MCP / 桌面端文档里的正式名字；`FK_DATA_DIR` 是 CLI 的简写别名。
 * 默认值不强行统一：桌面端与安装目录同级（`__dirname/data`），CLI/MCP 跟当前工作目录（`./data`），
 * 这是两种运行形态的真实差异，不该抹平。
 */
export function resolveDataDir(fallback: string, explicit?: string): string {
  return explicit || process.env.VAULT_DATA_DIR || process.env.FK_DATA_DIR || fallback;
}
