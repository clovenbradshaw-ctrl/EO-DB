/**
 * CSV / JSON parser contract for the file-upload importer.
 *
 * The hot edges:
 *   - Airtable's CSV export uses doubled-quote escaping inside quoted
 *     fields. Newlines and commas inside quotes must NOT split rows
 *     or columns.
 *   - Excel exports include a UTF-8 BOM. The parser must strip it
 *     before treating the first byte as data.
 *   - JSON exports come in a few shapes — top-level array, or wrapped
 *     in { records: [...] } / { data: [...] } / { items: [...] }.
 */

import { describe, it, expect } from 'vitest';
import { parseCsv, parseJson, parseByName } from '../parse';

describe('parseCsv', () => {
  it('parses a simple header + rows pair', () => {
    const { columns, rows } = parseCsv('Name,Age\nAlice,30\nBob,25');
    expect(columns).toEqual(['Name', 'Age']);
    expect(rows).toEqual([
      { Name: 'Alice', Age: '30' },
      { Name: 'Bob', Age: '25' },
    ]);
  });

  it('handles quoted fields containing commas and newlines', () => {
    const { rows } = parseCsv('Name,Bio\nAlice,"a, b\nc"\nBob,plain');
    expect(rows).toEqual([
      { Name: 'Alice', Bio: 'a, b\nc' },
      { Name: 'Bob', Bio: 'plain' },
    ]);
  });

  it('handles doubled-quote escaping inside quoted fields', () => {
    const { rows } = parseCsv('Name,Quote\nAlice,"She said ""hi"""');
    expect(rows[0].Quote).toBe('She said "hi"');
  });

  it('strips a UTF-8 BOM from the first cell name', () => {
    const csv = '﻿Name,Age\nAlice,30';
    const { columns, rows } = parseCsv(csv);
    expect(columns).toEqual(['Name', 'Age']);
    expect(rows[0].Name).toBe('Alice');
  });

  it('accepts CRLF and bare CR line endings', () => {
    expect(parseCsv('a,b\r\nx,y').rows).toEqual([{ a: 'x', b: 'y' }]);
    expect(parseCsv('a,b\rx,y').rows).toEqual([{ a: 'x', b: 'y' }]);
  });

  it('skips entirely-empty rows (e.g. trailing newline)', () => {
    const { rows } = parseCsv('a,b\nx,y\n');
    expect(rows).toHaveLength(1);
  });

  it('produces empty-string cells for missing columns at end-of-row', () => {
    const { rows } = parseCsv('a,b,c\nx,y');
    expect(rows[0]).toEqual({ a: 'x', b: 'y', c: '' });
  });
});

describe('parseJson', () => {
  it('parses a top-level array of objects', () => {
    const { columns, rows } = parseJson('[{"a":1},{"a":2,"b":"x"}]');
    expect(rows).toEqual([{ a: 1 }, { a: 2, b: 'x' }]);
    expect(new Set(columns)).toEqual(new Set(['a', 'b']));
  });

  it('finds the records array under "records" / "data" / "items" / "rows"', () => {
    expect(parseJson('{"records":[{"a":1}]}').rows).toEqual([{ a: 1 }]);
    expect(parseJson('{"data":[{"a":1}]}').rows).toEqual([{ a: 1 }]);
    expect(parseJson('{"items":[{"a":1}]}').rows).toEqual([{ a: 1 }]);
    expect(parseJson('{"rows":[{"a":1}]}').rows).toEqual([{ a: 1 }]);
  });

  it('throws a friendly error for invalid JSON', () => {
    expect(() => parseJson('{not json}')).toThrow(/Invalid JSON/);
  });

  it('throws when the records array cannot be located', () => {
    expect(() => parseJson('{"other":[1,2,3]}')).toThrow(/records \/ data \/ items \/ rows/);
  });

  it('drops non-object array entries silently (id-only strings, nulls, etc.)', () => {
    const { rows } = parseJson('[{"a":1},null,"hello",{"a":2}]');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('parseByName', () => {
  it('routes .csv to the CSV parser', () => {
    const out = parseByName('a,b\n1,2', 'foo.csv');
    expect(out.columns).toEqual(['a', 'b']);
  });

  it('routes .json to the JSON parser', () => {
    const out = parseByName('[{"a":1}]', 'foo.json');
    expect(out.rows).toEqual([{ a: 1 }]);
  });

  it('falls back to JSON when the content sniffs as JSON regardless of extension', () => {
    const out = parseByName('[{"a":1}]', 'noextension');
    expect(out.rows).toEqual([{ a: 1 }]);
  });

  it('falls back to CSV otherwise', () => {
    const out = parseByName('a,b\n1,2', 'noextension');
    expect(out.columns).toEqual(['a', 'b']);
  });
});
