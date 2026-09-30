'use strict';

// Optional build-time bootstrap for the StreamList Lab Python control probe.
// Failure never blocks QwertBot deployment; the Lab will report Python as
// unavailable and the Minimal Node probe can still run.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(__dirname, 'python_vendor');
const requirements = path.join(__dirname, 'streamlist-python-requirements.txt');

function clean(value, limit = 1200) {
  return String(value || '').replace(/\r/g, '').trim().slice(-limit);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env || process.env
  });
}

function verify(env = process.env) {
  return run('python3', ['-c', 'import grpc,google.protobuf; print(grpc.__version__); print(google.protobuf.__version__)'], { env, timeout: 15000 });
}

function logResult(prefix, result) {
  const out = clean(result?.stdout);
  const err = clean(result?.stderr || result?.error?.message);
  if (out) console.log(`${prefix} ${out.replace(/\n+/g, ' / ')}`);
  if (err) console.warn(`${prefix} ${err.replace(/\n+/g, ' / ')}`);
}

function main() {
  const system = verify();
  if (!system.error && system.status === 0) {
    console.log('[StreamList Lab] Python grpcio/protobuf already available in the environment; vendor install not needed.');
    return 0;
  }

  const vendorEnv = {
    ...process.env,
    PYTHONPATH: [vendorDir, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
  };
  const vendored = verify(vendorEnv);
  if (!vendored.error && vendored.status === 0) {
    const versions = clean(vendored.stdout).split(/\n+/).filter(Boolean);
    console.log(`[StreamList Lab] Bundled Python probe dependencies already READY (grpcio ${versions[0] || '?'}, protobuf ${versions[1] || '?'}).`);
    return 0;
  }

  const python = run('python3', ['--version'], { timeout: 10000 });
  if (python.error || python.status !== 0) {
    console.warn('[StreamList Lab] Optional Python probe unavailable: python3 is not installed. QwertBot build will continue.');
    logResult('[StreamList Lab]', python);
    return 0;
  }

  if (!fs.existsSync(requirements)) {
    console.warn('[StreamList Lab] Optional Python probe unavailable: requirements file is missing. QwertBot build will continue.');
    return 0;
  }

  const pip = run('python3', ['-m', 'pip', '--version'], { timeout: 15000 });
  if (pip.error || pip.status !== 0) {
    console.warn('[StreamList Lab] Optional Python probe unavailable: python3 exists but pip is unavailable. QwertBot build will continue.');
    logResult('[StreamList Lab]', pip);
    return 0;
  }

  try {
    fs.rmSync(vendorDir, { recursive: true, force: true });
    fs.mkdirSync(vendorDir, { recursive: true });
  } catch (err) {
    console.warn(`[StreamList Lab] Could not prepare Python vendor directory: ${clean(err?.message || err)}. QwertBot build will continue.`);
    return 0;
  }

  console.log('[StreamList Lab] Installing optional Python grpcio/protobuf probe dependencies into diagnostics/python_vendor...');
  const install = run('python3', [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-input',
    '--only-binary=:all:',
    '--upgrade',
    '--target', vendorDir,
    '-r', requirements
  ], { timeout: 180000 });

  if (install.error || install.status !== 0) {
    console.warn('[StreamList Lab] Optional Python dependency install failed. QwertBot build will continue; the Lab will show Python as unavailable.');
    logResult('[StreamList Lab]', install);
    return 0;
  }

  const env = {
    ...process.env,
    PYTHONPATH: [vendorDir, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
  };
  const check = verify(env);
  if (check.error || check.status !== 0) {
    console.warn('[StreamList Lab] Python dependencies installed but verification failed. QwertBot build will continue.');
    logResult('[StreamList Lab]', check);
    return 0;
  }

  const versions = clean(check.stdout).split(/\n+/).filter(Boolean);
  console.log(`[StreamList Lab] Python probe dependencies READY (grpcio ${versions[0] || '?'}, protobuf ${versions[1] || '?'}).`);
  return 0;
}

process.exitCode = main();
