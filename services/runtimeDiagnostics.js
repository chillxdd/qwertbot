const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

function readNumericFile(path) {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (_) {
    return null;
  }
}

function getMemoryLimitBytes() {
  const cgroupV2 = readNumericFile('/sys/fs/cgroup/memory.max');
  if (cgroupV2 && cgroupV2 < Number.MAX_SAFE_INTEGER) {
    return { bytes: cgroupV2, source: 'cgroup-v2' };
  }

  const cgroupV1 = readNumericFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // Some runtimes expose a huge sentinel when no real cgroup limit exists.
  if (cgroupV1 && cgroupV1 < (2 ** 50)) {
    return { bytes: cgroupV1, source: 'cgroup-v1' };
  }

  return { bytes: null, source: null };
}

function nsToMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n / 1e6 : null;
}

function getRuntimeDiagnostics() {
  const memory = process.memoryUsage();
  const limit = getMemoryLimitBytes();
  const rssPercent = limit.bytes ? (memory.rss / limit.bytes) * 100 : null;

  const eventLoopMeanMs = nsToMs(eventLoopHistogram.mean);
  const eventLoopP95Ms = nsToMs(eventLoopHistogram.percentile(95));
  const eventLoopMaxMs = nsToMs(eventLoopHistogram.max);
  eventLoopHistogram.reset();

  return {
    capturedAt: new Date().toISOString(),
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`
    },
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      limitBytes: limit.bytes,
      limitSource: limit.source,
      rssPercent: Number.isFinite(rssPercent) ? rssPercent : null
    },
    eventLoop: {
      meanLagMs: eventLoopMeanMs,
      p95LagMs: eventLoopP95Ms,
      maxLagMs: eventLoopMaxMs
    },
    system: {
      hostname: os.hostname(),
      cpuCountVisible: os.cpus()?.length || null
    }
  };
}

module.exports = { getRuntimeDiagnostics };
