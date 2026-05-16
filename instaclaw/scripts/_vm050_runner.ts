import { readFileSync } from 'fs';
import { Client } from 'ssh2';

async function main() {
  const localScript = process.argv[2];
  if (!localScript) { console.error('USAGE: _vm050_runner.ts <local-script-path>'); process.exit(1); }
  for (const f of ['.env.local', '.env.ssh-key']) {
    for (const l of readFileSync(f, 'utf-8').split('\n')) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const c = new Client();
  await new Promise<void>((r, j) => {
    c.on('ready', () => r());
    c.on('error', j);
    c.connect({
      host: '172.239.36.76',
      port: 22,
      username: 'openclaw',
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, 'base64').toString('utf-8'),
      readyTimeout: 10000,
      keepaliveInterval: 5000,
    });
  });
  const exec = (cmd: string) =>
    new Promise<string>((r) => {
      let o = '';
      c.exec(cmd, (e, s) => {
        if (e) return r('SSHERR: ' + e.message);
        s.on('data', (d: Buffer) => (o += d.toString()));
        s.stderr.on('data', (d: Buffer) => (o += d.toString()));
        s.on('close', () => r(o));
      });
    });
  const script = readFileSync(localScript, 'utf-8');
  const remotePath = `/tmp/_runner_${Date.now()}.sh`;
  await new Promise<void>((r, j) => {
    c.sftp((e, sftp) => {
      if (e) return j(e);
      const w = sftp.createWriteStream(remotePath);
      w.on('close', () => r());
      w.on('error', j);
      w.end(script);
    });
  });
  const out = await exec(`chmod +x ${remotePath} && ${remotePath} 2>&1; rm -f ${remotePath}`);
  process.stdout.write(out);
  c.end();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
