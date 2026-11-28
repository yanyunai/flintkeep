/**
 * 收支 / 成本 / 任务 / 资料证书 / 灵感池 的统一数据出口。
 *
 * 这几类业务数据从赛博老爸（workstation-OPC）时代起就存在**同一个集合**里：
 *   collections/workbench = { revenue, costs, tasks, docs, ideas, chats, settings }
 * 机房场景的 iframe 每存一次盘就把这一整包写回来。
 *
 * 之前几个自有页面各读一张自己的空表（collections/revenue、collections/tasks…），
 * 结果就是：场景里明明有数据，新页面却显示 0 条，看着像"数据丢了"。
 *
 * 这里统一读同一包、按 key 合并后再整包写回，两边永远是同一份数据。
 */

const BUCKET = '/api/collections/workbench';

async function readBucket(): Promise<Record<string, any>> {
  const r = await fetch(BUCKET, { cache: 'no-store' });
  const j = await r.json();
  const d = j?.data;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}

export async function loadBucket<T>(key: string): Promise<T[]> {
  const d = await readBucket();
  const v = d[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function saveBucket(key: string, rows: any[]): Promise<void> {
  // 必须整包写（iframe 也是整包写的），所以先读出来再改一个 key，别把 chats/settings 抹掉
  const d = await readBucket();
  d[key] = rows;
  await fetch(BUCKET, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: d }),
  });
  // 通知外壳：把最新数据同步回机房场景，避免场景那边再用旧 S 覆盖回来
  try {
    window.dispatchEvent(new CustomEvent('mg:collection-changed'));
  } catch {
    /* 忽略 */
  }
}
