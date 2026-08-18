import { describe, expect, test } from 'bun:test';
import { selectMcpOperations } from '../src/commands/serve-http.ts';

describe('anonymous MCP operation surface', () => {
  test('Given cloud-firewall access When anonymous MCP operations are selected Then only remote read and write operations remain', () => {
    const operations = selectMcpOperations(true);
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.scope === 'read' || operation.scope === 'write')).toBe(true);
    expect(operations.some((operation) => operation.scope === 'admin')).toBe(false);
    expect(operations.some((operation) => operation.scope === 'agent')).toBe(false);
    expect(operations.some((operation) => operation.scope === 'sources_admin')).toBe(false);
    expect(operations.some((operation) => operation.scope === 'users_admin')).toBe(false);
    expect(operations.some((operation) => operation.localOnly === true)).toBe(false);
  });

  test('Given bearer-auth mode When operations are selected Then non-local privileged operations remain available to scoped callers', () => {
    const operations = selectMcpOperations(false);
    expect(operations.some((operation) => operation.scope === 'admin')).toBe(true);
    expect(operations.some((operation) => operation.localOnly === true)).toBe(false);
  });
});
