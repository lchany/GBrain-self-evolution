import { describe, expect, test } from 'bun:test';
import {
  GBRAIN_SERVER_CAPABILITIES,
  GBRAIN_SERVER_INSTRUCTIONS,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
} from '../src/mcp/discovery.ts';

describe('MCP discovery catalog', () => {
  test('advertises tools, prompts, and resources with server instructions', () => {
    expect(Object.keys(GBRAIN_SERVER_CAPABILITIES).sort()).toEqual(['prompts', 'resources', 'tools']);
    expect(typeof GBRAIN_SERVER_INSTRUCTIONS).toBe('string');
  });

  test('lists prompts and resolves each prompt to MCP message structure', () => {
    const { prompts } = listPrompts();
    expect(prompts.length).toBeGreaterThan(0);

    for (const prompt of prompts) {
      const args = Object.fromEntries(
        (prompt.arguments ?? []).map(argument => [argument.name, `${argument.name}-value`]),
      );
      const result = getPrompt(prompt.name, args);
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[0]?.role).toBe('user');
      expect(result.messages[0]?.content.type).toBe('text');
    }
  });

  test('rejects unknown prompts and missing required arguments', () => {
    expect(() => getPrompt('unknown', {})).toThrow();
    expect(() => getPrompt('search_knowledge', {})).toThrow();
  });

  test('lists resources and reads each URI as text content', () => {
    const { resources } = listResources();
    expect(resources.length).toBeGreaterThan(0);

    for (const resource of resources) {
      const result = readResource(resource.uri);
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content?.uri).toBe(resource.uri);
      expect(content?.mimeType).toBe('text/markdown');
      expect(content !== undefined && 'text' in content).toBe(true);
      if (content !== undefined && 'text' in content) {
        expect(typeof content.text).toBe('string');
      }
    }
  });

  test('rejects unknown resource URIs', () => {
    expect(() => readResource('gbrain://unknown')).toThrow();
  });

  test('page schema documents project binding and canonical registry paths', () => {
    const result = readResource('gbrain://schema/page');
    const content = result.contents[0];
    const text = content !== undefined && 'text' in content ? content.text : '';
    expect(text).toContain('project_binding');
    expect(text).toContain('projects/<project_id>/index');
    expect(text).toContain('Project experience drafts must be bound before `put_page`');
    expect(text).toContain('source_project_ids');
  });
});
