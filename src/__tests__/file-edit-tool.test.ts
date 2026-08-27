/**
 * Tests for the file_edit tool.
 *
 * The headline case is dollar-sign handling: String.prototype.replace() treats
 * `$&`, `$\``, `$'`, `$1` and `$$` in a STRING replacement as substitution
 * patterns. Using it here silently corrupted any edit whose replacement text
 * contained a dollar sign — shell scripts, regex code, template literals.
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileEditDefinition, fileEditHandler } from '../loop/tools/file-edit';

describe('file_edit', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'woodbury-file-edit-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const ctx = () => ({ workingDirectory: workDir } as any);

  async function seed(name: string, content: string): Promise<string> {
    const p = join(workDir, name);
    await writeFile(p, content, 'utf-8');
    return p;
  }

  describe('dollar-sign replacement patterns', () => {
    // Each of these is a replacement string that String.replace() would expand.
    const cases: Array<{ label: string; replacement: string }> = [
      { label: "$' (portion after match)", replacement: "echo \"$'quoted'\"" },
      { label: '$& (whole match)', replacement: 'const price = "$&5.00";' },
      { label: '$` (portion before match)', replacement: 'cmd $`backtick`' },
      { label: '$1 (capture group ref)', replacement: 'sed -e "s/a/$1/"' },
      { label: '$$ (literal dollar escape)', replacement: 'PID=$$' },
    ];

    for (const { label, replacement } of cases) {
      it(`writes ${label} verbatim`, async () => {
        const path = await seed('script.sh', 'line one\nMARKER\nline three\n');

        await fileEditHandler(
          { path: 'script.sh', old_string: 'MARKER', new_string: replacement },
          ctx()
        );

        const result = await readFile(path, 'utf-8');
        expect(result).toBe(`line one\n${replacement}\nline three\n`);
      });
    }

    it('does not duplicate file content when replacement contains $\'', async () => {
      // The specific corruption: $' splices in everything after the match, so a
      // corrupted write is much larger than the original.
      const original = 'header\nMARKER\n' + 'padding line\n'.repeat(50);
      const path = await seed('big.sh', original);

      await fileEditHandler(
        { path: 'big.sh', old_string: 'MARKER', new_string: "x=$'y'" },
        ctx()
      );

      const result = await readFile(path, 'utf-8');
      expect(result).toContain("x=$'y'");
      // Corruption would roughly double the file; a literal write keeps it close.
      expect(result.length).toBeLessThan(original.length + 20);
    });

    it('handles dollar patterns under replace_all too', async () => {
      const path = await seed('multi.sh', 'A\nMARKER\nB\nMARKER\nC\n');

      await fileEditHandler(
        { path: 'multi.sh', old_string: 'MARKER', new_string: '$& and $1', replace_all: true },
        ctx()
      );

      expect(await readFile(path, 'utf-8')).toBe('A\n$& and $1\nB\n$& and $1\nC\n');
    });
  });

  describe('permission classification', () => {
    it('is marked dangerous so --safe blocks it like file_write', () => {
      // file_edit overwrites existing file contents; if this is false it slips
      // past the allowDangerousTools gate that file_write is subject to.
      expect(fileEditDefinition.dangerous).toBe(true);
    });
  });

  describe('match semantics', () => {
    it('replaces only the first occurrence when unique', async () => {
      const path = await seed('one.txt', 'alpha beta gamma\n');
      await fileEditHandler(
        { path: 'one.txt', old_string: 'beta', new_string: 'BETA' },
        ctx()
      );
      expect(await readFile(path, 'utf-8')).toBe('alpha BETA gamma\n');
    });

    it('refuses an ambiguous match without replace_all', async () => {
      await seed('dup.txt', 'x\nx\n');
      await expect(
        fileEditHandler({ path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx())
      ).rejects.toThrow(/found 2 times/);
    });

    it('replaces every occurrence with replace_all', async () => {
      const path = await seed('dup.txt', 'x\nx\nx\n');
      await fileEditHandler(
        { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true },
        ctx()
      );
      expect(await readFile(path, 'utf-8')).toBe('y\ny\ny\n');
    });

    it('reports when old_string is absent', async () => {
      await seed('none.txt', 'nothing here\n');
      await expect(
        fileEditHandler({ path: 'none.txt', old_string: 'absent', new_string: 'x' }, ctx())
      ).rejects.toThrow(/not found in file/);
    });

    it('can delete text with an empty new_string', async () => {
      const path = await seed('del.txt', 'keep REMOVE keep\n');
      await fileEditHandler(
        { path: 'del.txt', old_string: ' REMOVE', new_string: '' },
        ctx()
      );
      expect(await readFile(path, 'utf-8')).toBe('keep keep\n');
    });

    it('rejects an empty old_string', async () => {
      await seed('e.txt', 'content\n');
      await expect(
        fileEditHandler({ path: 'e.txt', old_string: '', new_string: 'x' }, ctx())
      ).rejects.toThrow(/must not be empty/);
    });

    it('rejects a no-op edit', async () => {
      await seed('same.txt', 'content\n');
      await expect(
        fileEditHandler({ path: 'same.txt', old_string: 'content', new_string: 'content' }, ctx())
      ).rejects.toThrow(/identical/);
    });

    it('reports a missing file distinctly from a missing match', async () => {
      await expect(
        fileEditHandler({ path: 'ghost.txt', old_string: 'a', new_string: 'b' }, ctx())
      ).rejects.toThrow(/File not found/);
    });
  });

  describe('multi-line edits', () => {
    it('preserves surrounding content exactly', async () => {
      const path = await seed(
        'block.ts',
        'before\nfunction a() {\n  return 1;\n}\nafter\n'
      );

      await fileEditHandler(
        {
          path: 'block.ts',
          old_string: 'function a() {\n  return 1;\n}',
          new_string: 'function a() {\n  return 2;\n}',
        },
        ctx()
      );

      expect(await readFile(path, 'utf-8')).toBe(
        'before\nfunction a() {\n  return 2;\n}\nafter\n'
      );
    });
  });
});
