# EO-DB — Claude Code Development Rules

## MANDATORY: TypeScript Build Check

After editing ANY `.ts` or `.tsx` file under `github-matrix-dev/app/`, you MUST run:

```bash
cd github-matrix-dev/app && npx tsc -b --noEmit
```

Run this BEFORE committing. Do NOT commit if it fails. Fix all errors first.

The CI pipeline runs `tsc -b && vite build` on every push to `main` — the same errors will fail the deploy.

## TypeScript Error Checklist

These 5 patterns have repeatedly broken CI. Verify each one when editing TypeScript:

### 1. Interface completeness
When adding a field to an interface or type, **grep for every place that constructs an object of that type** and add the new field to each one. Missing fields on even one construction site will fail `tsc`.

### 2. Union type narrowing
When accessing a property that only exists on some members of a union type, use an `in` guard before accessing it:
```ts
// WRONG — direct cast on a union
const keyed = (result as { keyed: KeyedSummary }).keyed;

// RIGHT — narrow first
const keyed = 'keyed' in result ? (result as { keyed: KeyedSummary }).keyed : null;
```
Never cast a union type directly to access a member-specific property.

### 3. Dead code after early returns
If you add an early `return` to disable a function body, **delete all code below it**. TypeScript's control-flow analysis will reject variable references in unreachable code. For unused parameters, add `void paramName;` before the return.

### 4. Browser API type mismatches
`Uint8Array` is NOT assignable to `BufferSource` or `BodyInit` in strict mode. When passing binary data to Web APIs (`fetch`, `SubtleCrypto`, etc.):
```ts
// For fetch body: wrap in Blob
fetch(url, { method: 'PUT', body: new Blob([data]) });

// For SubtleCrypto: cast explicitly
crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
```

### 5. Duplicate exports
Before adding a named export, verify the same name isn't already exported from that file. `tsc` rejects duplicate export identifiers.

## Project Layout

| Path | Description |
|------|-------------|
| `github-matrix-dev/app/` | React/Vite/TypeScript frontend (build: `tsc -b && vite build`) |
| `github-matrix-dev/app/tsconfig.json` | Strict mode, ES2022, noEmit, bundler resolution |
| `src/` | Server-side EO-DB engine (Fastify/LevelDB) |
| `.github/workflows/deploy.yml` | Deploys `github-matrix-dev/app/` to GitHub Pages on push to `main` |
