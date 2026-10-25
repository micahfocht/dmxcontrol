import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function executable(file, body) {
  await writeFile(file, body);
  await chmod(file, 0o755);
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dmx-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Exercise systemd quoting and Bash replacement characters in real paths.
  const project = path.join(dir, 'desk & room % $test');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const units = path.join(dir, 'units');
  for (const folder of [path.join(project, 'deploy'), path.join(project, 'data'), home, bin, units]) await mkdir(folder, { recursive: true });
  await copyFile(path.join(root, 'deploy/dmxcontrol@.service'), path.join(project, 'deploy/dmxcontrol@.service'));
  await writeFile(path.join(project, 'data/state.json'), '{"master":43}\n');

  const release = 'node-v22.99.0-linux-x64';
  const unpack = path.join(dir, 'unpack');
  await mkdir(path.join(unpack, release, 'bin'), { recursive: true });
  await mkdir(path.join(unpack, release, 'lib/node_modules/npm/bin'), { recursive: true });
  await executable(path.join(unpack, release, 'bin/node'), '#!/usr/bin/env bash\nexec "$TEST_REAL_NODE" "$@"\n');
  await writeFile(path.join(unpack, release, 'lib/node_modules/npm/bin/npm-cli.js'), `
    require('node:fs').appendFileSync(process.env.TEST_LOG, JSON.stringify(['npm', ...process.argv.slice(2)]) + '\\n');
    if (process.env.TEST_NPM_FAIL) process.exit(1);
  `);
  const archive = path.join(dir, `${release}.tar.xz`);
  await exec('tar', ['-cJf', archive, '-C', unpack, release]);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  const checksums = path.join(dir, 'SHASUMS256.txt');
  await writeFile(checksums, `${hash}  ${release}.tar.xz\n`);

  const mock = `#!${process.execPath}
    const fs = require('node:fs');
    const name = require('node:path').basename(process.argv[1]);
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_LOG, JSON.stringify([name, ...args]) + '\\n');
    if (name === 'curl') {
      const url = args.find(a => a.startsWith('http'));
      const output = args[args.indexOf('-o') + 1];
      if (url.endsWith('/SHASUMS256.txt')) fs.copyFileSync(process.env.TEST_CHECKSUMS, output);
      else if (url.endsWith('.tar.xz')) {
        if (url !== 'https://nodejs.org/dist/v22.99.0/node-v22.99.0-linux-x64.tar.xz') process.exit(2);
        fs.copyFileSync(process.env.TEST_ARCHIVE, output);
      } else if (url.includes('/api/health')) process.stdout.write(process.env.TEST_HEALTH || '{"ok":true,"persistenceError":null}');
      else process.exit(2);
    } else if (name === 'systemctl' && args[0] === 'cat') {
      process.exit(fs.existsSync(require('node:path').join(process.env.TEST_UNITS, args[1])) ? 0 : 1);
    }
  `;
  for (const name of ['curl', 'systemctl', 'apt-get', 'journalctl']) await executable(path.join(bin, name), mock);
  const log = path.join(dir, 'calls.jsonl');
  await writeFile(log, '');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_REAL_NODE: process.execPath,
    TEST_LOG: log, TEST_ARCHIVE: archive, TEST_CHECKSUMS: checksums, TEST_UNITS: units,
  };
  const { username } = userInfo();
  const gid = (await exec('id', ['-gn'])).stdout.trim();
  const harness = `
    source ${quote(path.join(root, 'install.sh'))}
    PROJECT_DIR=${quote(project)}
    NODE_DIR=${quote(path.join(dir, 'runtime'))}
    UNIT_DIR=${quote(units)}
    require_platform() {
      install_user=${quote(username)}; install_group=${quote(gid)}
      install_home=${quote(home)}; node_arch=x64
    }
    run_root() { if [[ $1 != chown ]]; then "$@"; fi; }
    run_as_user() { "$@"; }
    sleep() { :; }
    main "$@"
  `;
  return {
    dir, project, home, units, checksums, env,
    data: path.join(home, '.local/share/dmxcontrol'),
    service: `dmxcontrol@${username}.service`,
    async run(args = [], extraEnv = {}) { return exec('bash', ['-c', harness, 'installer-test', ...args], { env: { ...env, ...extraEnv } }); },
    async calls() { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    async clear() { await writeFile(log, ''); },
  };
}

test('installer starts a fresh deployment, imports settings, and reruns with saved port and OLA', async t => {
  const f = await fixture(t);
  await f.run(['--port', '3100']);
  assert.equal(await readFile(path.join(f.data, 'state.json'), 'utf8'), '{"master":43}\n');
  assert.equal(await readFile(path.join(f.data, 'install-port'), 'utf8'), '3100\n');
  let calls = await f.calls();
  assert.ok(calls.some(c => c[0] === 'npm' && c.slice(1).join(' ') === 'ci --omit=dev --no-audit --no-fund'));
  assert.ok(calls.some(c => c[0] === 'systemctl' && c[1] === 'enable' && c[2] === f.service));
  assert.ok(calls.some(c => c[0] === 'systemctl' && c[1] === 'restart' && c[2] === f.service));
  assert.ok(!calls.some(c => c[0] === 'systemctl' && c[1] === 'stop'));
  const unit = await readFile(path.join(f.units, f.service), 'utf8');
  assert.ok(unit.includes(`WorkingDirectory=${f.project.replaceAll('%', '%%')}`));
  assert.ok(unit.includes('Environment=PORT=3100'));
  assert.ok(!/@(?:PROJECT_DIR|DATA_DIR|NODE|PORT)@/.test(unit));
  // Validate the generated unit with the real systemd parser when available.
  try {
    await exec('systemd-analyze', ['verify', path.join(f.units, f.service)]);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(path.join(f.data, 'state.json'), '{"master":71}\n');
  await f.clear();
  await f.run(['--with-ola']);
  assert.equal(await readFile(path.join(f.data, 'state.json'), 'utf8'), '{"master":71}\n');
  calls = await f.calls();
  assert.ok(!calls.some(c => c[0] === 'curl' && c.some(a => a.endsWith('.tar.xz'))), 'reuse the installed release');
  assert.ok(calls.some(c => c[0] === 'systemctl' && c.slice(1).join(' ') === 'enable --now olad.service'));
  assert.ok(calls.some(c => c[0] === 'apt-get' && c.includes('ola')));
  const stopped = calls.findIndex(c => c[0] === 'systemctl' && c[1] === 'stop');
  const npm = calls.findIndex(c => c[0] === 'npm');
  assert.ok(stopped >= 0 && stopped < npm, 'stop before replacing dependencies');
  assert.ok((await readFile(path.join(f.units, f.service), 'utf8')).includes('Environment=PORT=3100'));
});

test('installer rejects a bad Node checksum before replacing dependencies or starting services', async t => {
  const f = await fixture(t);
  await writeFile(f.checksums, `${'0'.repeat(64)}  node-v22.99.0-linux-x64.tar.xz\n`);
  await assert.rejects(f.run(), e => /checksum verification failed/.test(e.stderr));
  assert.ok(!(await f.calls()).some(c => c[0] === 'npm' || c[0] === 'systemctl' && ['stop', 'restart', 'enable'].includes(c[1])));
});

test('installer reports failed dependency installation and never enables the app', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([], { TEST_NPM_FAIL: '1' }), e => /Installation failed/.test(e.stderr));
  assert.ok(!(await f.calls()).some(c => c[0] === 'systemctl' && ['restart', 'enable'].includes(c[1])));
});

test('installer rejects an unhealthy response instead of reporting success', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([], { TEST_HEALTH: '{"ok":true,"persistenceError":"disk full"}' }), e => /did not become healthy/.test(e.stderr));
  await assert.rejects(access(path.join(f.data, 'install-port')));
});

test('installer validates arguments before making system changes', async () => {
  for (const args of [['--port', '80'], ['--port', '65536'], ['--port', ''], ['--port'], ['--unknown']]) {
    await assert.rejects(exec('bash', [path.join(root, 'install.sh'), ...args]), e => /Error:/.test(e.stderr));
  }
  assert.match((await exec('bash', [path.join(root, 'install.sh'), '--help'])).stdout, /Usage:/);
});

test('updater fast-forwards origin/main, reruns setup, and rejects local modifications', { skip: userInfo().uid === 0 && 'Run updater tests as a non-root checkout owner.' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dmx-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, 'upstream');
  const checkout = path.join(dir, 'checkout');
  const git = (cwd, ...args) => exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  await mkdir(upstream);
  await git(upstream, 'init', '-b', 'main');
  await copyFile(path.join(root, 'update.sh'), path.join(upstream, 'update.sh'));
  await executable(path.join(upstream, 'install.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > installed\n');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-m', 'Initial');
  await git(dir, 'clone', upstream, checkout);
  await writeFile(path.join(upstream, 'new-version'), 'new version');
  await writeFile(path.join(upstream, 'update.sh'), `#!/usr/bin/env bash\n${'# A self-update changes the script being executed.\n'.repeat(30)}${await readFile(path.join(root, 'update.sh'), 'utf8')}`);
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-m', 'Update');
  const run = () => exec('bash', ['./update.sh', '--port', '3100'], { cwd: checkout });
  await run();
  assert.equal(await readFile(path.join(checkout, 'new-version'), 'utf8'), 'new version');
  assert.equal(await readFile(path.join(checkout, 'installed'), 'utf8'), '--port\n3100\n');
  await writeFile(path.join(checkout, 'new-version'), 'local edit');
  await assert.rejects(run(), e => /Commit or stash/.test(e.stderr));
  await git(checkout, 'restore', 'new-version');
  await git(checkout, 'checkout', '-b', 'feature');
  await assert.rejects(run(), e => /require the main branch/.test(e.stderr));
  await git(checkout, 'checkout', 'main');
  await writeFile(path.join(checkout, 'local-commit'), 'local');
  await git(checkout, 'add', 'local-commit');
  await git(checkout, 'commit', '-m', 'Local commit');
  await assert.rejects(run(), e => /commits outside origin\/main/.test(e.stderr));
});
