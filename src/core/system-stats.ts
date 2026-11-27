/**
 * 本机资源监控（跨平台，只读采集，不装任何第三方依赖）。
 *
 * macOS  : top / sysctl / df / netstat / ioreg / pmset / system_profiler
 * Windows: PowerShell + CIM（CPU/内存/磁盘/GPU/网络/温度尽力而为）
 * Linux  : /proc/stat、/proc/meminfo、/proc/net/dev、df、nvidia-smi、thermal_zone
 *
 * 采集结果缓存 2 秒：前端 3 秒轮询一次，不会把系统命令打爆。
 * 拿不到的指标返回 null，由前端标注「不可用」，绝不编造数值。
 */
import { execFile } from 'child_process';
import * as os from 'os';
import { t } from '../shared/i18n';

export interface SystemStats {
  platform: string;
  hostname: string;
  model: string;
  /** 当前登录用户名，前端拼 sudo 授权命令要用 */
  user: string;
  uptimeSec: number;
  processes: number | null;
  cpu: {
    model: string;
    cores: number;
    usagePct: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
  };
  mem: {
    totalBytes: number;
    /** 总已用（App + Wired + Compressed，与活动监视器口径一致） */
    usedBytes: number | null;
    usagePct: number | null;
    /** App 内存（Anonymous pages）：关掉程序会立刻下降，最能反映实际占用 */
    appBytes?: number | null;
    appPct?: number | null;
    wiredBytes?: number | null;
    compressedBytes?: number | null;
    swapUsedBytes?: number | null;
    swapTotalBytes?: number | null;
    /** 系统内存压力：剩余百分比越低越吃紧 */
    pressureFreePct?: number | null;
  };
  disk: { totalBytes: number; usedBytes: number; freeBytes: number; usagePct: number };
  net: { rxBps: number | null; txBps: number | null };
  gpu: {
    name: string;
    cores: number | null;
    /** 可信的利用率；拿不到就是 null，绝不填假数 */
    usagePct: number | null;
    /** 已用显存（macOS/Apple Silicon 上是统一内存占用，真实变化） */
    memUsedBytes?: number | null;
    /** GPU 功耗（W），来自 powermetrics */
    powerW?: number | null;
    /** 为什么没有利用率，前端直接展示给用户看 */
    usageNote?: string | null;
  } | null;
  temp: {
    cpuC: number | null;
    source: string | null;
    note?: string | null;
    /** 散热压力等级（Nominal/Fair/Serious/Critical）：拿不到温度时的替代信息 */
    thermalPressure?: string | null;
  } | null;
  battery: { pct: number; charging: boolean } | null;
  power: string | null;
  capabilities: string[];
  checkedAt: string;
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

function toBytes(value: string, unit: string): number {
  const n = Number(value) || 0;
  if (/g/i.test(unit)) return n * 1024 ** 3;
  if (/m/i.test(unit)) return n * 1024 ** 2;
  if (/k/i.test(unit)) return n * 1024;
  return n;
}

/** 从「标签: 数值」型输出里取数（vm_stat / memory_pressure），取不到返回 NaN */
function labelNum(text: string, label: string): number {
  const safe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*"?${safe}"?:\\s+([\\d.]+)`, 'm').exec(text);
  return m ? Number(m[1]) : NaN;
}

/** 非负整数百分比，NaN 归到 null */
function pctOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/* ------------------------------ 网络速率 ------------------------------ */
let lastNet: { rx: number; tx: number; at: number } | null = null;

function netRate(rx: number, tx: number): { rxBps: number | null; txBps: number | null } {
  const at = Date.now();
  const prev = lastNet;
  lastNet = { rx, tx, at };
  if (!prev || at <= prev.at) return { rxBps: null, txBps: null };
  const sec = (at - prev.at) / 1000;
  return {
    rxBps: Math.max(0, Math.round((rx - prev.rx) / sec)),
    txBps: Math.max(0, Math.round((tx - prev.tx) / sec)),
  };
}

/* CPU 利用率：直接对 os.cpus() 的累计时间片做差，比每 3 秒跑一次 top 便宜两个数量级。
   实测 top -l 2 -n 0 -s 1 单次要 2.2 秒 CPU 时间，3 秒轮询下几乎吃满一个核。 */
let lastCpuTicks: { total: number; idle: number } | null = null;

function osCpuUsage(): number | null {
  let total = 0;
  let idle = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
    idle += t.idle;
  }
  const prev = lastCpuTicks;
  lastCpuTicks = { total, idle };
  if (!prev) return null;
  const dt = total - prev.total;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (idle - prev.idle) / dt) * 100)));
}

function osUserName(): string {
  try { return os.userInfo().username || ''; } catch { return ''; }
}

/* ------------------------------ macOS ------------------------------ */
let darwinGpuCache: { at: number; name: string; cores: number | null } | null = null;

async function darwinGpuModel(): Promise<{ name: string; cores: number | null }> {
  if (darwinGpuCache && Date.now() - darwinGpuCache.at < 5 * 60_000) return darwinGpuCache;
  const out = await run('system_profiler', ['SPDisplaysDataType'], 8000);
  const name = /Chipset Model:\s*(.+)/.exec(out)?.[1]?.trim() || 'GPU';
  const cores = Number(/Total Number of Cores:\s*(\d+)/.exec(out)?.[1] || 0) || null;
  darwinGpuCache = { at: Date.now(), name, cores };
  return darwinGpuCache;
}

/* GPU 利用率：macOS 上唯一可信的来源是 powermetrics 的 GPU HW active residency（要 root）。
   用户配一条 NOPASSWD sudoers 规则后就能读到；没配就返回 null，界面标「未授权」。
   结果缓存，避免每 3 秒轮询都拉起一次 powermetrics。 */
export function parseGpuUtil(text: string): number | null {
  const hw = Number(/GPU HW active residency:\s*([\d.]+)%/.exec(text)?.[1]);
  if (!Number.isFinite(hw)) return null;
  return Math.max(0, Math.min(100, Math.round(hw)));
}

export function parseCpuTemp(text: string): number | null {
  const v = Number(/CPU die temperature:\s*([\d.]+)/i.exec(text)?.[1]);
  return Number.isFinite(v) ? v : null;
}

/** GPU 功耗：powermetrics 给的是 mW，转成一位小数的 W */
export function parseGpuPowerW(text: string): number | null {
  const mw = Number(/GPU Power:\s*([\d.]+)\s*mW/i.exec(text)?.[1]);
  return Number.isFinite(mw) ? Math.round(mw / 100) / 10 : null;
}

/** powermetrics 单次采样约 0.3~0.4 秒；没授权时命令立刻失败，所以失败重试很便宜 */
let gpuUtilProbe: { at: number; pct: number | null; powerW: number | null } | null = null;

type GpuProbe = { pct: number | null; powerW: number | null; note: string | null };

async function darwinGpuUtil(): Promise<GpuProbe> {
  const now = Date.now();
  const fresh = gpuUtilProbe && now - gpuUtilProbe.at < (gpuUtilProbe.pct == null ? 15_000 : 10_000);
  if (!fresh) {
    const out = await run('sudo', ['-n', 'powermetrics', '--samplers', 'gpu_power', '-n', '1', '-i', '300'], 8000);
    gpuUtilProbe = { at: now, pct: parseGpuUtil(out), powerW: parseGpuPowerW(out) };
  }
  const p = gpuUtilProbe!;
  return {
    pct: p.pct,
    powerW: p.powerW,
    note: p.pct != null ? null : t('stat.gpu.needSudo'),
  };
}

type TempProbe = { cpuC: number | null; source: string | null; note: string | null; thermalPressure: string | null };
let lastTemp: { at: number; value: TempProbe } | null = null;

/** 温度：优先免授权工具（istats / osx-cpu-temp / smctemp），其次 powermetrics。
    注意 Apple Silicon 上 powermetrics 已经没有 smc 采样器，只有 thermal 的「散热压力等级」，
    所以拿不到温度时退回压力等级，并明说需要装 smctemp 才有温度读数。 */
async function darwinTemp(): Promise<TempProbe> {
  const now = Date.now();
  if (lastTemp && now - lastTemp.at < 15_000) return lastTemp.value;

  const tools = await run('sh', ['-c', 'command -v istats osx-cpu-temp smctemp 2>/dev/null'], 2000);
  let value: TempProbe;
  if (tools.includes('istats')) {
    const v = parseCpuTemp(await run('istats', ['cpu', 'temp'], 2000));
    value = { cpuC: v, source: 'istats', note: v == null ? t('stat.temp.istatsNull') : null, thermalPressure: null };
  } else if (tools.includes('osx-cpu-temp')) {
    const out = await run('osx-cpu-temp', [], 2000);
    const v = Number(/([\d.]+)/.exec(out)?.[1]);
    value = { cpuC: Number.isFinite(v) ? v : null, source: 'osx-cpu-temp', note: null, thermalPressure: null };
  } else if (tools.includes('smctemp')) {
    // Apple Silicon 能用的温度工具，需要 root 读 SMC
    const out = await run('sudo', ['-n', 'smctemp', '-c'], 3000);
    const v = Number(/([\d.]+)/.exec(out)?.[1]);
    value = { cpuC: Number.isFinite(v) ? v : null, source: 'smctemp', note: null, thermalPressure: null };
  } else {
    // 兜底：powermetrics thermal 只给散热压力等级
    const out = await run('sudo', ['-n', 'powermetrics', '--samplers', 'thermal', '-n', '1', '-i', '200'], 4000);
    const pressure = /Current pressure level:\s*(\w+)/i.exec(out)?.[1] || null;
    const denied = !out.trim();
    value = {
      cpuC: null,
      source: null,
      note: denied
        ? t('stat.temp.needSudo')
        : t('stat.temp.noSmctemp'),
      thermalPressure: pressure,
    };
  }
  lastTemp = { at: now, value };
  return value;
}

async function collectDarwin(): Promise<SystemStats> {
  const [sysctlMem, boot, disk, netstat, ioreg, vmStat, swapRaw, memPressure, psOut, gpu, gpuUtil, temp, batt] = await Promise.all([
    run('sysctl', ['-n', 'hw.memsize', 'hw.ncpu', 'hw.model'], 3000),
    run('sysctl', ['-n', 'kern.boottime'], 2000),
    run('df', ['-k', '/'], 3000),
    run('netstat', ['-ib'], 3000),
    run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], 3000),
    run('vm_stat', [], 3000),
    run('sysctl', ['-n', 'vm.swapusage'], 2000),
    run('memory_pressure', ['-Q'], 4000),
    run('ps', ['-A', '-o', 'pid='], 3000),
    darwinGpuModel(),
    darwinGpuUtil(),
    darwinTemp(),
    run('pmset', ['-g', 'batt'], 2000),
  ]);

  const sysLines = sysctlMem.split('\n').map((s) => s.trim()).filter(Boolean);
  const totalMem = Number(sysLines[0]) || os.totalmem();
  const cores = Number(sysLines[1]) || os.cpus().length;
  const model = sysLines[2] || os.hostname();

  const usagePct = osCpuUsage();
  const load = os.loadavg();

  /* 内存：以前读 top 的 PhysMem used，它把压缩页也算进已用，所以关掉程序后几乎不动。
     真正会立刻回落的是 Anonymous pages（App 内存）；这里把 App / Wired / 压缩 / Swap 全拆开。 */
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]) || 16384;
  const vmBytes = (label: string): number => {
    const n = labelNum(vmStat, label);
    return Number.isFinite(n) ? n * pageSize : NaN;
  };
  const appMem = vmBytes('Anonymous pages');
  const wiredMem = vmBytes('Pages wired down');
  const compressedMem = vmBytes('Pages occupied by compressor');
  // 活动监视器口径：App + Wired + 压缩
  const usedMem = [appMem, wiredMem, compressedMem].every(Number.isFinite)
    ? appMem + wiredMem + compressedMem
    : null;
  const usedBytes = usedMem;

  const swapHit = /total\s*=\s*([\d.]+)([KMG])B?\s+used\s*=\s*([\d.]+)([KMG])/i.exec(swapRaw);
  const swapTotalBytes = swapHit ? Math.round(toBytes(swapHit[1], swapHit[2])) : null;
  const swapUsedBytes = swapHit ? Math.round(toBytes(swapHit[3], swapHit[4])) : null;
  const pressureFreeRaw = labelNum(memPressure, 'System-wide memory free percentage');

  const processes = psOut.trim() ? psOut.trim().split('\n').length : null;
  const bootSec = Number(/sec\s*=\s*(\d+)/.exec(boot)?.[1] || 0);
  const uptimeSec = bootSec ? Math.max(0, Math.floor(Date.now() / 1000 - bootSec)) : Math.floor(os.uptime());

  const dfLine = disk.trim().split('\n').pop()?.trim().split(/\s+/) || [];
  const totalBytes = Number(dfLine[1]) * 1024 || 0;
  const usedDisk = Number(dfLine[2]) * 1024 || 0;
  const freeBytes = Number(dfLine[3]) * 1024 || 0;

  let rx = 0;
  let tx = 0;
  for (const line of netstat.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (/^lo/i.test(f[0])) continue;
    if (!f.some((x) => x.includes('<Link'))) continue;
    // 从行尾倒数：Coll / Obytes / Oerrs / Opkts / Ibytes
    rx += Number(f[f.length - 5]) || 0;
    tx += Number(f[f.length - 2]) || 0;
  }
  const net = netRate(rx, tx);

  /* Apple Silicon 上 ioreg 的「Device Utilization %」是恒定的假值：
     实测机器 CPU 还有 57% 空闲时它也一直报 99~100%，且与 Tiler Utilization 自相矛盾。
     所以利用率一律给 null（前端标「不可用」），只保留真实会变的显存占用。 */
  const gpuMemHit = /"In use system memory"\s*=\s*(\d+)/.exec(ioreg);
  const gpuMemUsed = gpuMemHit ? Number(gpuMemHit[1]) : NaN;

  const battPct = Number(/(\d+)%/.exec(batt)?.[1]);
  const battery = /InternalBattery/i.test(batt) && Number.isFinite(battPct)
    ? { pct: battPct, charging: /charging/i.test(batt) && !/discharging/i.test(batt) }
    : null;

  return {
    platform: 'darwin',
    hostname: os.hostname(),
    user: osUserName(),
    model,
    uptimeSec,
    processes,
    cpu: {
      model: os.cpus()[0]?.model || 'Apple Silicon',
      cores,
      usagePct,
      load1: load[0] ?? null,
      load5: load[1] ?? null,
      load15: load[2] ?? null,
    },
    mem: {
      totalBytes: totalMem,
      usedBytes,
      usagePct: pctOf(usedBytes ?? NaN, totalMem),
      // App 内存：关掉程序会立刻下降，前端用它当主口径
      appBytes: Number.isFinite(appMem) ? appMem : null,
      appPct: pctOf(appMem, totalMem),
      wiredBytes: Number.isFinite(wiredMem) ? wiredMem : null,
      compressedBytes: Number.isFinite(compressedMem) ? compressedMem : null,
      swapUsedBytes,
      swapTotalBytes,
      pressureFreePct: Number.isFinite(pressureFreeRaw) ? pressureFreeRaw : null,
    },
    disk: {
      totalBytes,
      usedBytes: usedDisk,
      freeBytes,
      usagePct: totalBytes ? Math.round((usedDisk / totalBytes) * 100) : 0,
    },
    net,
    gpu: gpu.name
      ? {
        name: gpu.name,
        cores: gpu.cores,
        usagePct: gpuUtil.pct,
        memUsedBytes: Number.isFinite(gpuMemUsed) ? gpuMemUsed : null,
        powerW: gpuUtil.powerW,
        usageNote: gpuUtil.note,
      }
      : null,
    temp,
    battery,
    power: /AC Power/i.test(batt) ? 'AC' : null,
    capabilities: [
      'cpu', 'mem', 'disk', 'net', 'gpu',
      ...(temp.cpuC != null ? ['temp'] : []),
      ...(battery ? ['battery'] : []),
    ],
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------ Windows ------------------------------ */
async function collectWin32(): Promise<SystemStats> {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    '$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;',
    '$os=Get-CimInstance Win32_OperatingSystem;',
    '$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'";',
    '$g=Get-CimInstance Win32_VideoController | Select-Object -First 1;',
    '$n=(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum;',
    '$nt=(Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum;',
    '$t=(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1).CurrentTemperature;',
    '[pscustomobject]@{cpu=$cpu;memTotal=[int64]$os.TotalVisibleMemorySize*1024;memFree=[int64]$os.FreePhysicalMemory*1024;',
    'diskTotal=[int64]$d.Size;diskFree=[int64]$d.FreeSpace;gpu=$g.Name;rx=[int64]$n;tx=[int64]$nt;',
    'tempK=$t;uptime=[int64]((Get-Date)-$os.LastBootUpTime).TotalSeconds;procs=[int]((Get-Process).Count)} | ConvertTo-Json -Compress',
  ].join('');
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 12000);
  let j: any = {};
  try { j = JSON.parse(out.trim() || '{}'); } catch { /* ignore */ }

  const totalMem = Number(j.memTotal) || os.totalmem();
  const freeMem = Number(j.memFree);
  const usedBytes = Number.isFinite(freeMem) ? totalMem - freeMem : null;
  const diskTotal = Number(j.diskTotal) || 0;
  const diskFree = Number(j.diskFree) || 0;
  const tempC = Number.isFinite(Number(j.tempK)) && Number(j.tempK) > 0
    ? Math.round(Number(j.tempK) / 10 - 273.15)
    : null;

  return {
    platform: 'win32',
    hostname: os.hostname(),
    user: osUserName(),
    model: os.cpus()[0]?.model || '',
    uptimeSec: Number(j.uptime) || Math.floor(os.uptime()),
    processes: Number(j.procs) || null,
    cpu: {
      model: os.cpus()[0]?.model || '',
      cores: os.cpus().length,
      usagePct: Number.isFinite(Number(j.cpu)) ? Math.round(Number(j.cpu)) : null,
      load1: null, load5: null, load15: null,
    },
    mem: {
      totalBytes: totalMem,
      usedBytes,
      usagePct: usedBytes ? Math.round((usedBytes / totalMem) * 100) : null,
    },
    disk: {
      totalBytes: diskTotal,
      usedBytes: diskTotal - diskFree,
      freeBytes: diskFree,
      usagePct: diskTotal ? Math.round(((diskTotal - diskFree) / diskTotal) * 100) : 0,
    },
    net: netRate(Number(j.rx) || 0, Number(j.tx) || 0),
    gpu: j.gpu ? { name: String(j.gpu), cores: null, usagePct: null, usageNote: t('stat.gpu.windows') } : null,
    temp: { cpuC: tempC, source: tempC != null ? 'MSAcpi_ThermalZone' : null },
    battery: null,
    power: null,
    capabilities: ['cpu', 'mem', 'disk', 'net', ...(tempC != null ? ['temp'] : []), ...(j.gpu ? ['gpu'] : [])],
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------ Linux ------------------------------ */
let lastLinuxCpu: { idle: number; total: number } | null = null;

async function collectLinux(): Promise<SystemStats> {
  const fs = await import('fs');
  const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

  const stat = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = (stat[3] || 0) + (stat[4] || 0);
  const total = stat.reduce((a, b) => a + b, 0);
  let usagePct: number | null = null;
  if (lastLinuxCpu) {
    const dt = total - lastLinuxCpu.total;
    const di = idle - lastLinuxCpu.idle;
    if (dt > 0) usagePct = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  }
  lastLinuxCpu = { idle, total };

  const memInfo = read('/proc/meminfo');
  const memField = (k: string) => Number(new RegExp(`^${k}:\\s*(\\d+)`, 'm').exec(memInfo)?.[1]);
  const kb = (k: string) => { const v = memField(k); return Number.isFinite(v) ? v * 1024 : NaN; };
  const memTotal = kb('MemTotal') || 0;
  const memAvail = kb('MemAvailable') || 0;
  const usedBytes = memTotal ? Math.max(0, memTotal - memAvail) : null;
  // 与 macOS 对齐：App 内存（匿名页）、Swap
  const appMem = kb('AnonPages');
  const swapTotalBytes = kb('SwapTotal') || 0;
  const swapFreeBytes = kb('SwapFree') || 0;

  const load = os.loadavg();
  const [df, netdev, nvsmi, thermal] = await Promise.all([
    run('df', ['-k', '/'], 3000),
    Promise.resolve(read('/proc/net/dev')),
    run('nvidia-smi', ['--query-gpu=name,utilization.gpu', '--format=csv,noheader,nounits'], 3000),
    Promise.resolve(read('/sys/class/thermal/thermal_zone0/temp')),
  ]);

  const dfLine = df.trim().split('\n').pop()?.trim().split(/\s+/) || [];
  const diskTotal = Number(dfLine[1]) * 1024 || 0;
  const diskUsed = Number(dfLine[2]) * 1024 || 0;
  const diskFree = Number(dfLine[3]) * 1024 || 0;

  let rx = 0;
  let tx = 0;
  for (const line of netdev.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || /^\s*lo$/.test(name)) continue;
    const f = rest.trim().split(/\s+/);
    rx += Number(f[0]) || 0;
    tx += Number(f[8]) || 0;
  }

  const gpuParts = nvsmi.trim().split(',');
  // nvidia-smi 真给 0% 也要保留（0 是有效值，不是「拿不到」）
  const nvUtil = gpuParts[1]?.trim() ? Number(gpuParts[1]) : NaN;
  const tempC = Number(thermal) > 0 ? Math.round(Number(thermal) / 1000) : null;

  return {
    platform: 'linux',
    hostname: os.hostname(),
    user: osUserName(),
    model: os.cpus()[0]?.model || '',
    uptimeSec: Math.floor(os.uptime()),
    processes: null,
    cpu: {
      model: os.cpus()[0]?.model || '',
      cores: os.cpus().length,
      usagePct,
      load1: load[0], load5: load[1], load15: load[2],
    },
    mem: {
      totalBytes: memTotal,
      usedBytes,
      usagePct: pctOf(usedBytes ?? NaN, memTotal),
      appBytes: Number.isFinite(appMem) ? appMem : null,
      appPct: pctOf(appMem, memTotal),
      swapUsedBytes: swapTotalBytes ? Math.max(0, swapTotalBytes - swapFreeBytes) : null,
      swapTotalBytes: swapTotalBytes || null,
    },
    disk: {
      totalBytes: diskTotal,
      usedBytes: diskUsed,
      freeBytes: diskFree,
      usagePct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
    },
    net: netRate(rx, tx),
    gpu: gpuParts[0]
      ? {
        name: gpuParts[0].trim(),
        cores: null,
        usagePct: Number.isFinite(nvUtil) ? Math.max(0, Math.min(100, Math.round(nvUtil))) : null,
        usageNote: Number.isFinite(nvUtil) ? null : t('stat.gpu.noNvidia'),
      }
      : null,
    temp: { cpuC: tempC, source: tempC != null ? 'thermal_zone0' : null },
    battery: null,
    power: null,
    capabilities: ['cpu', 'mem', 'disk', 'net', ...(tempC != null ? ['temp'] : []), ...(gpuParts[0] ? ['gpu'] : [])],
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------ 缓存入口 ------------------------------ */
let cache: SystemStats | null = null;
let cacheAt = 0;
let inFlight: Promise<SystemStats> | null = null;

export async function getSystemStats(maxAgeMs = 2000): Promise<SystemStats> {
  if (cache && Date.now() - cacheAt < maxAgeMs) return cache;
  if (inFlight) return inFlight;
  const collect = process.platform === 'darwin'
    ? collectDarwin
    : process.platform === 'win32' ? collectWin32 : collectLinux;
  inFlight = collect()
    .then((s) => { cache = s; cacheAt = Date.now(); return s; })
    .catch(() => {
      // 采集失败时给一份只含 os 模块数据的兜底结果，前端不至于整排消失
      const fallback: SystemStats = {
        platform: process.platform, hostname: os.hostname(), model: '', user: osUserName(),
        uptimeSec: Math.floor(os.uptime()), processes: null,
        cpu: { model: os.cpus()[0]?.model || '', cores: os.cpus().length, usagePct: null, load1: null, load5: null, load15: null },
        mem: { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem(), usagePct: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100) },
        disk: { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePct: 0 },
        net: { rxBps: null, txBps: null },
        gpu: null, temp: null, battery: null, power: null,
        capabilities: ['cpu', 'mem'], checkedAt: new Date().toISOString(),
      };
      cache = fallback; cacheAt = Date.now();
      return fallback;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}
