import { describe, it, expect } from 'vitest';
import {
  parseDefDeclarations,
  discoverStructure,
  populateEntities,
  resolveEdges,
  inferCooccurrence,
  runEdgeDetection,
  toEoEvents,
  csvToCollections,
  type DefDeclaration,
  type ExplicitEdge,
  type InferredEdge,
} from '../src/ingestion/edge-detection.js';

// ─── Test Data ───────────────────────────────────────────────────────────────

const LAW_FIRM_DATA = {
  attorneys: [
    { id: 'ATT-001', name: 'Alice Chen', specialty: 'immigration' },
    { id: 'ATT-002', name: 'Bob Davis', specialty: 'corporate' },
    { id: 'ATT-003', name: 'Carol Evans', specialty: 'immigration' },
  ],
  cases: [
    { id: 'CASE-001', title: 'H1B Petition', lead_attorney: 'ATT-001', team: ['ATT-001', 'ATT-003'], related_cases: ['CASE-002'] },
    { id: 'CASE-002', title: 'Corp Filing', lead_attorney: 'ATT-002', team: ['ATT-002'], related_cases: ['CASE-001', 'CASE-003'] },
    { id: 'CASE-003', title: 'Green Card', lead_attorney: 'ATT-001', team: ['ATT-001', 'ATT-002', 'ATT-003'], related_cases: [] },
  ],
  clients: [
    { id: 'CLI-001', name: 'Acme Corp', primary_case: 'CASE-002' },
    { id: 'CLI-002', name: 'Jane Doe', primary_case: 'CASE-001' },
    { id: 'CLI-003', name: 'Phantom LLC', primary_case: 'CASE-999' },
  ],
  documents: [
    { id: 'DOC-001', title: 'Brief', produced_by: 'ATT-001' },
    { id: 'DOC-002', title: 'Evidence', produced_by: 'EPA' },
  ],
};

const LAW_FIRM_JSON = JSON.stringify(LAW_FIRM_DATA);

const LAW_FIRM_DEFS = `
# Attorney assignments
DEF(cases.lead_attorney → attorneys)
DEF(cases.team → attorneys)
DEF(cases.related_cases → cases)

# Client relationships
DEF(clients.primary_case → cases)

# Documents with wildcard
DEF(documents.produced_by → *)
`;

const CONTACTS_CSV = `id,name,case_ref,collaborators
C-001,Alice,CASE-001,"C-002,C-003"
C-002,Bob,CASE-002,"C-001"
C-003,Carol,CASE-001,"C-001,C-002"`;

const CONTACTS_DEFS = `
DEF(contacts.case_ref -> cases)
DEF(contacts.collaborators -> contacts, delimiter=",")
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('parseDefDeclarations', () => {
  it('parses a basic declaration', () => {
    const defs = parseDefDeclarations('DEF(cases.lead_attorney → attorneys)');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      sourceCollection: 'cases',
      sourceField: 'lead_attorney',
      targetCollection: 'attorneys',
    });
  });

  it('parses a wildcard target', () => {
    const defs = parseDefDeclarations('DEF(documents.produced_by → *)');
    expect(defs[0].targetCollection).toBe('*');
  });

  it('parses a declaration with delimiter option', () => {
    const defs = parseDefDeclarations('DEF(contacts.tags → categories, delimiter=",")');
    expect(defs[0].delimiter).toBe(',');
  });

  it('skips comments and blank lines', () => {
    const text = `
# This is a comment
DEF(a.b → c)

# Another comment

DEF(d.e → f)
`;
    const defs = parseDefDeclarations(text);
    expect(defs).toHaveLength(2);
  });

  it('accepts ASCII arrow -> as alternative', () => {
    const defs = parseDefDeclarations('DEF(cases.lead -> attorneys)');
    expect(defs[0]).toEqual({
      sourceCollection: 'cases',
      sourceField: 'lead',
      targetCollection: 'attorneys',
    });
  });

  it('throws on malformed line', () => {
    expect(() => parseDefDeclarations('not a def')).toThrow('Malformed DEF declaration');
  });
});

describe('Step 1: SIG — discoverStructure', () => {
  it('discovers collections from object keys', () => {
    const registry = discoverStructure(LAW_FIRM_DATA);
    expect([...registry.keys()]).toEqual(
      expect.arrayContaining(['attorneys', 'cases', 'clients', 'documents']),
    );
  });

  it('identifies the correct ID field per collection', () => {
    const registry = discoverStructure(LAW_FIRM_DATA);
    expect(registry.get('attorneys')!.idField).toBe('id');
    expect(registry.get('cases')!.idField).toBe('id');
    expect(registry.get('clients')!.idField).toBe('id');
  });

  it('detects ID prefix patterns', () => {
    const registry = discoverStructure(LAW_FIRM_DATA);
    const attPattern = registry.get('attorneys')!.pattern;
    expect(attPattern).toBeDefined();
    expect(attPattern!.test('ATT-001')).toBe(true);
    expect(attPattern!.test('hello')).toBe(false);
  });

  it('handles CSV single-collection input', () => {
    const collections = csvToCollections(CONTACTS_CSV, 'contacts');
    const registry = discoverStructure(collections);
    expect(registry.has('contacts')).toBe(true);
    expect(registry.get('contacts')!.idField).toBe('id');
    expect(registry.get('contacts')!.recordCount).toBe(3);
  });
});

describe('Step 2: INS — populateEntities', () => {
  it('populates all entities across collections', () => {
    const registry = discoverStructure(LAW_FIRM_DATA);
    const entities = populateEntities(LAW_FIRM_DATA, registry);
    // 3 attorneys + 3 cases + 3 clients + 2 documents = 11
    expect(entities.size).toBe(11);
  });

  it('keys entities by their ID values', () => {
    const registry = discoverStructure(LAW_FIRM_DATA);
    const entities = populateEntities(LAW_FIRM_DATA, registry);
    expect(entities.has('ATT-001')).toBe(true);
    expect(entities.has('CASE-003')).toBe(true);
    expect(entities.has('CLI-002')).toBe(true);
    expect(entities.has('DOC-001')).toBe(true);
  });

  it('stores correct collection name per entity', () => {
    const registry = discoverStructure(LAW_FIRM_DATA);
    const entities = populateEntities(LAW_FIRM_DATA, registry);
    expect(entities.get('ATT-001')!.collection).toBe('attorneys');
    expect(entities.get('CASE-001')!.collection).toBe('cases');
    expect(entities.get('CLI-001')!.collection).toBe('clients');
  });
});

describe('Step 3: DEF→CON — resolveEdges', () => {
  const typeRegistry = discoverStructure(LAW_FIRM_DATA);
  const entityRegistry = populateEntities(LAW_FIRM_DATA, typeRegistry);

  it('resolves scalar field to single edge per record', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'lead_attorney', targetCollection: 'attorneys' }];
    const { explicitEdges } = resolveEdges(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // 3 cases, each with one lead_attorney
    expect(explicitEdges).toHaveLength(3);
    expect(explicitEdges[0]).toMatchObject({
      source: 'CASE-001',
      target: 'ATT-001',
      field: 'lead_attorney',
      type: 'explicit',
    });
  });

  it('resolves array field to multiple edges', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'team', targetCollection: 'attorneys' }];
    const { explicitEdges } = resolveEdges(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // CASE-001: 2, CASE-002: 1, CASE-003: 3 = 6 total
    expect(explicitEdges).toHaveLength(6);
  });

  it('resolves self-referential DEF', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'related_cases', targetCollection: 'cases' }];
    const { explicitEdges } = resolveEdges(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // CASE-001→CASE-002, CASE-002→CASE-001, CASE-002→CASE-003
    expect(explicitEdges).toHaveLength(3);
    expect(explicitEdges.some(e => e.source === 'CASE-001' && e.target === 'CASE-002')).toBe(true);
    expect(explicitEdges.some(e => e.source === 'CASE-002' && e.target === 'CASE-001')).toBe(true);
  });

  it('tracks unresolved references', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'clients', sourceField: 'primary_case', targetCollection: 'cases' }];
    const { explicitEdges, unresolvedRefs } = resolveEdges(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    expect(explicitEdges).toHaveLength(2); // CLI-001→CASE-002, CLI-002→CASE-001
    expect(unresolvedRefs).toHaveLength(1);
    expect(unresolvedRefs[0]).toMatchObject({
      source: 'CLI-003',
      field: 'primary_case',
      value: 'CASE-999',
    });
  });

  it('resolves wildcard DEF against all collections', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'documents', sourceField: 'produced_by', targetCollection: '*' }];
    const { explicitEdges, unresolvedRefs } = resolveEdges(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // DOC-001.produced_by = ATT-001 → resolves
    expect(explicitEdges).toHaveLength(1);
    expect(explicitEdges[0].target).toBe('ATT-001');
    expect(explicitEdges[0].targetCollection).toBe('attorneys');
    // DOC-002.produced_by = "EPA" → unresolved
    expect(unresolvedRefs).toHaveLength(1);
    expect(unresolvedRefs[0].value).toBe('EPA');
  });

  it('splits CSV string fields using delimiter', () => {
    const csvCollections = csvToCollections(CONTACTS_CSV, 'contacts');
    const csvTypeReg = discoverStructure(csvCollections);
    const csvEntityReg = populateEntities(csvCollections, csvTypeReg);

    const defs: DefDeclaration[] = [
      { sourceCollection: 'contacts', sourceField: 'collaborators', targetCollection: 'contacts', delimiter: ',' },
    ];
    const { explicitEdges } = resolveEdges(defs, csvCollections, csvTypeReg, csvEntityReg);
    // C-001→C-002, C-001→C-003, C-002→C-001, C-003→C-001, C-003→C-002
    expect(explicitEdges).toHaveLength(5);
  });

  it('produces no edges for empty/null fields', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'related_cases', targetCollection: 'cases' }];
    const { explicitEdges } = resolveEdges(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // CASE-003 has related_cases: [] — should contribute 0 edges
    const fromCase3 = explicitEdges.filter(e => e.source === 'CASE-003');
    expect(fromCase3).toHaveLength(0);
  });
});

describe('Step 4: SYN — inferCooccurrence', () => {
  const typeRegistry = discoverStructure(LAW_FIRM_DATA);
  const entityRegistry = populateEntities(LAW_FIRM_DATA, typeRegistry);

  it('generates co-occurrence edges for array fields', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'team', targetCollection: 'attorneys' }];
    const inferred = inferCooccurrence(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    expect(inferred.length).toBeGreaterThan(0);
    expect(inferred.every(e => e.type === 'inferred')).toBe(true);
  });

  it('produces correct pairs from CASE-003 team', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'team', targetCollection: 'attorneys' }];
    const inferred = inferCooccurrence(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // CASE-003 team=[ATT-001, ATT-002, ATT-003] → 3 pairs
    // Also CASE-001 team=[ATT-001, ATT-003] → 1 pair
    // Unique pairs across all: ATT-001/ATT-002, ATT-001/ATT-003, ATT-002/ATT-003
    expect(inferred).toHaveLength(3);
  });

  it('accumulates counts across records', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'team', targetCollection: 'attorneys' }];
    const inferred = inferCooccurrence(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    // ATT-001/ATT-003 co-occur in CASE-001 and CASE-003
    const pair = inferred.find(e =>
      (e.source === 'ATT-001' && e.target === 'ATT-003') ||
      (e.source === 'ATT-003' && e.target === 'ATT-001'),
    );
    expect(pair).toBeDefined();
    expect(pair!.cooccurrenceCount).toBe(2);
  });

  it('tracks context per co-occurrence', () => {
    const defs: DefDeclaration[] = [{ sourceCollection: 'cases', sourceField: 'team', targetCollection: 'attorneys' }];
    const inferred = inferCooccurrence(defs, LAW_FIRM_DATA, typeRegistry, entityRegistry);
    const pair = inferred.find(e => e.source === 'ATT-001' && e.target === 'ATT-003');
    expect(pair!.contexts).toHaveLength(2);
    expect(pair!.contexts).toEqual(
      expect.arrayContaining([
        { parentId: 'CASE-001', field: 'team' },
        { parentId: 'CASE-003', field: 'team' },
      ]),
    );
  });
});

describe('runEdgeDetection — full pipeline', () => {
  it('runs end-to-end with explicit only mode', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, LAW_FIRM_DEFS, {
      format: 'json',
      outputMode: 'explicit',
    });
    expect(result.typeRegistry.size).toBe(4);
    expect(result.entityRegistry.size).toBe(11);
    expect(result.explicitEdges.length).toBeGreaterThan(0);
    expect(result.inferredEdges).toHaveLength(0);
    expect(result.explicitEdges.every(e => e.type === 'explicit')).toBe(true);
  });

  it('runs end-to-end with both output mode and co-occurrence', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, LAW_FIRM_DEFS, {
      format: 'json',
      outputMode: 'both',
      inferCooccurrence: true,
    });
    expect(result.explicitEdges.length).toBeGreaterThan(0);
    expect(result.inferredEdges.length).toBeGreaterThan(0);
  });

  it('returns inferred-only when output mode is inferred', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, LAW_FIRM_DEFS, {
      format: 'json',
      outputMode: 'inferred',
      inferCooccurrence: true,
    });
    expect(result.explicitEdges).toHaveLength(0);
    expect(result.inferredEdges.length).toBeGreaterThan(0);
  });

  it('handles CSV format input', () => {
    // CSV contacts + a subset of law firm JSON for cross-collection resolution
    const result = runEdgeDetection(CONTACTS_CSV, CONTACTS_DEFS, {
      format: 'csv',
      csvCollectionName: 'contacts',
    });
    expect(result.typeRegistry.has('contacts')).toBe(true);
    expect(result.entityRegistry.size).toBe(3);
    // case_ref edges are unresolved (cases collection doesn't exist in CSV-only data)
    expect(result.unresolvedRefs.length).toBeGreaterThan(0);
  });

  it('handles empty DEF text gracefully', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, '', {
      format: 'json',
    });
    expect(result.typeRegistry.size).toBe(4);
    expect(result.entityRegistry.size).toBe(11);
    expect(result.explicitEdges).toHaveLength(0);
    expect(result.inferredEdges).toHaveLength(0);
    expect(result.unresolvedRefs).toHaveLength(0);
  });
});

describe('toEoEvents', () => {
  it('generates INS events for all entities', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, '', { format: 'json' });
    const events = toEoEvents(result);
    const insEvents = events.filter(e => e.op === 'INS');
    expect(insEvents).toHaveLength(11);
    expect(insEvents[0].target).toMatch(/^import\./);
  });

  it('generates CON events for explicit edges', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, LAW_FIRM_DEFS, {
      format: 'json',
      outputMode: 'explicit',
    });
    const events = toEoEvents(result);
    const conEvents = events.filter(e => e.op === 'CON');
    expect(conEvents.length).toBe(result.explicitEdges.length);
    expect(conEvents[0].operand).toHaveProperty('added');
    expect(conEvents[0].operand).toHaveProperty('edge_type');
  });

  it('produces ImportEventRow-compatible output', () => {
    const result = runEdgeDetection(LAW_FIRM_JSON, LAW_FIRM_DEFS, { format: 'json' });
    const events = toEoEvents(result, 'lawfirm');
    for (const event of events) {
      expect(event).toHaveProperty('op');
      expect(event).toHaveProperty('target');
      expect(typeof event.op).toBe('string');
      expect(typeof event.target).toBe('string');
      expect(event.target.startsWith('lawfirm.')).toBe(true);
    }
  });
});
