import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';

const bootstrapScript = await readFile('deploy/scripts/bootstrap-server.sh', 'utf8');
const verifyScript = await readFile('deploy/scripts/verify-server.sh', 'utf8');
const runServerScript = await readFile('deploy/scripts/run-server.sh', 'utf8');
const serviceUnit = await readFile(
  'deploy/systemd/gbrain-serve-http.service.example',
  'utf8',
);

describe('deployment scripts', () => {
  test('pins the published repository and builds the installed binary', () => {
    expect(bootstrapScript).toContain(
      'https://github.com/lchany/GBrain-self-evolution.git',
    );
    expect(bootstrapScript).toContain('gbrain-review-ui');
    expect(bootstrapScript).toContain('bun run build');
    expect(bootstrapScript).toContain('/usr/local/bin/gbrain');
    expect(bootstrapScript).toContain('Preserving existing /etc/gbrain/gbrain-serve.env');
    expect(bootstrapScript).toContain('/root/.bun/bin/bun');
    expect(bootstrapScript).toContain('useradd --system');
    expect(bootstrapScript).toContain('GBRAIN_HOME=/var/lib/gbrain');
    expect(bootstrapScript).toContain('/var/lib/gbrain/.gbrain/config.json');
    expect(bootstrapScript).toContain('GBRAIN_PUBLIC_URL is required');
  });

  test('verifies the actual anonymous MCP endpoint', () => {
    expect(verifyScript).toContain('mcp="$(curl');
    expect(verifyScript).toContain('initialize');
    expect(verifyScript).toContain('Missing Authorization');
  });

  test('only advertises a public issuer when HTTPS is configured', () => {
    expect(runServerScript).toContain('== https://*');
    expect(runServerScript).toContain('--allow-anonymous-mcp');
    expect(serviceUnit).toContain('deploy/scripts/run-server.sh');
  });
});
