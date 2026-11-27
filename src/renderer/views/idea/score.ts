/**
 * 灵感评分：与 vendor 旧版 ideaScore 逐字一致，保证新旧排序完全相同。
 *
 * 需求强度、变现能力正向（越高越好）；竞争程度、开发成本反向（越高越扣分）。
 */
export type IdeaScoreInput = {
  demand?: number | string;
  monetize?: number | string;
  competition?: number | string;
  effort?: number | string;
};

export function ideaScore(i: IdeaScoreInput): number {
  // Number(v) 转不动（undefined/非数字）时用默认值；语义与旧版 `+v || 默认` 一致
  const num = (v: number | string | undefined, d: number): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  return Math.round(
    ((num(i.demand, 0) + num(i.monetize, 0)) * 2 +
      (6 - num(i.competition, 3)) +
      (6 - num(i.effort, 3))) /
      30 *
      100
  );
}

/** 分数分段配色：≥75 绿、≥60 蓝、其余橙（走模板 token，换皮肤自动跟随） */
export function scoreColor(score: number): string {
  if (score >= 75) return 'var(--ok)';
  if (score >= 60) return 'var(--info)';
  return 'var(--warn)';
}
