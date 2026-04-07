/**
 * Code Scanner — Walks the codebase and extracts structural entities.
 *
 * Uses regex-based parsing (no AST dependency) to extract:
 *   - Imports and their sources
 *   - Exports (named, default)
 *   - Functions and their boundaries
 *   - Interfaces and type aliases
 *   - React components and their hooks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  FileInfo,
  ImportInfo,
  ExportInfo,
  FunctionInfo,
  InterfaceInfo,
  TypeInfo,
  ComponentInfo,
} from './types.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  'coverage', '.turbo', '.vite',
]);

const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Recursively scan a directory for TypeScript files and extract code entities.
 */
export function scanDirectory(rootDir: string, baseDir: string): FileInfo[] {
  const results: FileInfo[] = [];
  walk(rootDir, baseDir, results);
  return results;
}

function walk(dir: string, baseDir: string, results: FileInfo[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walk(fullPath, baseDir, results);
      }
    } else if (entry.isFile() && TS_EXTENSIONS.has(path.extname(entry.name))) {
      const info = scanFile(fullPath, baseDir);
      if (info) results.push(info);
    }
  }
}

/**
 * Scan a single TypeScript file and extract all code entities.
 */
function scanFile(filePath: string, baseDir: string): FileInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const relativePath = path.relative(baseDir, filePath);

  return {
    path: filePath,
    relativePath,
    lines: lines.length,
    imports: extractImports(lines),
    exports: extractExports(lines),
    functions: extractFunctions(lines),
    interfaces: extractInterfaces(lines),
    types: extractTypes(lines),
    components: extractComponents(lines, content),
  };
}

// ─── Import extraction ───────────────────────────────────────────────────────

const IMPORT_RE = /^import\s+(?:(type)\s+)?(?:({[^}]+})|(\w+)(?:\s*,\s*({[^}]+}))?)\s+from\s+['"]([^'"]+)['"]/;
const IMPORT_SIDE_EFFECT_RE = /^import\s+['"]([^'"]+)['"]/;

function extractImports(lines: string[]): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(IMPORT_RE);
    if (match) {
      const isTypeOnly = !!match[1];
      const namedBlock = match[2] || match[4] || '';
      const defaultImport = match[3] || '';
      const source = match[5];

      const specifiers: string[] = [];
      if (defaultImport) specifiers.push(defaultImport);
      if (namedBlock) {
        const inner = namedBlock.replace(/[{}]/g, '');
        for (const s of inner.split(',')) {
          const name = s.trim().split(/\s+as\s+/).pop()?.trim();
          if (name) specifiers.push(name);
        }
      }

      results.push({
        source,
        specifiers,
        isDefault: !!defaultImport && !namedBlock,
        isTypeOnly,
        line: i + 1,
      });
      continue;
    }

    const sideEffect = line.match(IMPORT_SIDE_EFFECT_RE);
    if (sideEffect) {
      results.push({
        source: sideEffect[1],
        specifiers: [],
        isDefault: false,
        isTypeOnly: false,
        line: i + 1,
      });
    }
  }

  return results;
}

// ─── Export extraction ───────────────────────────────────────────────────────

function extractExports(lines: string[]): ExportInfo[] {
  const results: ExportInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // export default
    if (/^export\s+default\s+/.test(line)) {
      results.push({ name: 'default', kind: 'default', line: i + 1, isDefault: true });
      continue;
    }

    // export function
    const fnMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) {
      results.push({ name: fnMatch[1], kind: 'function', line: i + 1, isDefault: false });
      continue;
    }

    // export class
    const classMatch = line.match(/^export\s+class\s+(\w+)/);
    if (classMatch) {
      results.push({ name: classMatch[1], kind: 'class', line: i + 1, isDefault: false });
      continue;
    }

    // export interface
    const ifaceMatch = line.match(/^export\s+interface\s+(\w+)/);
    if (ifaceMatch) {
      results.push({ name: ifaceMatch[1], kind: 'interface', line: i + 1, isDefault: false });
      continue;
    }

    // export type
    const typeMatch = line.match(/^export\s+type\s+(\w+)/);
    if (typeMatch) {
      results.push({ name: typeMatch[1], kind: 'type', line: i + 1, isDefault: false });
      continue;
    }

    // export const/let
    const constMatch = line.match(/^export\s+(?:const|let)\s+(\w+)/);
    if (constMatch) {
      results.push({ name: constMatch[1], kind: 'const', line: i + 1, isDefault: false });
      continue;
    }

    // export enum
    const enumMatch = line.match(/^export\s+enum\s+(\w+)/);
    if (enumMatch) {
      results.push({ name: enumMatch[1], kind: 'enum', line: i + 1, isDefault: false });
    }
  }

  return results;
}

// ─── Function extraction ─────────────────────────────────────────────────────

function extractFunctions(lines: string[]): FunctionInfo[] {
  const results: FunctionInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^(export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (match) {
      const endLine = findBlockEnd(lines, i);
      results.push({
        name: match[2],
        line: i + 1,
        endLine: endLine + 1,
        isExported: !!match[1],
        isAsync: /async\s+function/.test(line),
      });
    }
  }

  return results;
}

/**
 * Find the closing brace of a block starting at the given line.
 */
function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; foundOpen = true; }
      if (ch === '}') { depth--; }
      if (foundOpen && depth === 0) return i;
    }
  }

  return Math.min(startLine + 50, lines.length - 1);
}

// ─── Interface extraction ────────────────────────────────────────────────────

function extractInterfaces(lines: string[]): InterfaceInfo[] {
  const results: InterfaceInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^(export\s+)?interface\s+(\w+)/);
    if (match) {
      const endLine = findBlockEnd(lines, i);
      let fieldCount = 0;
      for (let j = i + 1; j <= endLine; j++) {
        const fieldLine = lines[j].trim();
        if (fieldLine && !fieldLine.startsWith('//') && !fieldLine.startsWith('/*')
            && fieldLine !== '{' && fieldLine !== '}') {
          fieldCount++;
        }
      }
      results.push({
        name: match[2],
        line: i + 1,
        fieldCount,
        isExported: !!match[1],
      });
    }
  }

  return results;
}

// ─── Type alias extraction ───────────────────────────────────────────────────

function extractTypes(lines: string[]): TypeInfo[] {
  const results: TypeInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^(export\s+)?type\s+(\w+)\s*=/);
    if (match) {
      results.push({
        name: match[2],
        line: i + 1,
        isExported: !!match[1],
      });
    }
  }

  return results;
}

// ─── React component extraction ──────────────────────────────────────────────

const HOOK_RE = /\buse[A-Z]\w+/g;

function extractComponents(lines: string[], content: string): ComponentInfo[] {
  const results: ComponentInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // function Component() or const Component = () =>  or const Component: React.FC
    const fnComp = line.match(/^(export\s+)?(?:const|function)\s+([A-Z]\w+).*(?:=>|{|\()/);
    if (fnComp) {
      // Check if it returns JSX (look ahead for < or return <)
      const endLine = findBlockEnd(lines, i);
      const body = lines.slice(i, endLine + 1).join('\n');
      if (body.includes('return (') || body.includes('return <') || body.includes('=>') && body.includes('<')) {
        const hooks = (body.match(HOOK_RE) || []).filter(
          (h, idx, arr) => arr.indexOf(h) === idx
        );
        results.push({
          name: fnComp[2],
          line: i + 1,
          isExported: !!fnComp[1],
          hooks,
        });
      }
    }
  }

  return results;
}
