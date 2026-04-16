import { useState, useEffect, useCallback, useMemo } from 'react';
import type { MatrixSession } from '../matrix/client';
import { useTheme, type Theme } from '../theme';
import { useEoStore } from '../store/eo-store';
import { cacheSite } from '../sync/sites';
import { DEFAULT_CACHE_DEF, type CacheDefOperand } from '../sync/operators';
import { buildCacheDefEvent, measureStorageBytes, bytesToMb } from '../sync/archiver';
import { formatAgent } from '../sync/agent';

/**
 * Settings panel for the memory-fading policy. Emits DEF events on
 * `cache:<deviceId>` when the user saves — the archiver picks those up on
 * the next tick.
 */
export function MemoryFadingSettingsSection({ session }: { session: MatrixSession }) {
  const { theme } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);
  const getStateByTarget = useEoStore((s) => s.getState);
  const deviceId = session.deviceId;
  const userId = session.userId;

  const [def, setDef] = useState<CacheDefOperand>(DEFAULT_CACHE_DEF);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ usage_mb: number; quota_mb: number | null } | null>(null);

  // Load current cache DEF (if one exists) from the fold-derived state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await getStateByTarget(cacheSite(deviceId));
        if (cancelled) return;
        if (state && typeof state.value === 'object' && state.value) {
          const v = state.value as Partial<CacheDefOperand>;
          setDef({
            ...DEFAULT_CACHE_DEF,
            ...pickDefFields(v),
          });
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, getStateByTarget]);

  // Measure storage once on mount, then every 30s.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const m = await measureStorageBytes();
      if (cancelled || !m) return;
      setUsage({
        usage_mb: bytesToMb(m.usage_bytes),
        quota_mb: m.quota_bytes !== null ? bytesToMb(m.quota_bytes) : null,
      });
    };
    probe();
    const t = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const hotHours = Math.round(def.hot_window_ms / 3_600_000);
  const usageMbRounded = usage ? Math.round(usage.usage_mb) : null;
  const quotaMbRounded = usage?.quota_mb != null ? Math.round(usage.quota_mb) : null;
  const overHighWatermark = usage ? usage.usage_mb > def.high_watermark_mb : false;

  const canSave = useMemo(() => {
    if (!loaded) return false;
    if (def.low_watermark_mb >= def.high_watermark_mb) return false;
    if (def.high_watermark_mb <= 0) return false;
    if (def.min_attestation < 0) return false;
    if (def.hot_window_ms < 0) return false;
    return true;
  }, [def, loaded]);

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const event = buildCacheDefEvent({
        systemAgent: formatAgent(userId, deviceId),
        myDeviceId: deviceId,
        patch: def,
        nowIso: new Date().toISOString(),
      });
      await dispatch(event);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [canSave, def, deviceId, userId, dispatch]);

  const s = inlineStyles(theme);

  return (
    <>
      <div style={s.status}>
        <div style={s.statusLine}>
          <span style={s.statusKey}>Usage</span>
          <span style={{ ...s.statusVal, color: overHighWatermark ? theme.warning : theme.text }}>
            {usageMbRounded !== null ? `${usageMbRounded} MB` : '—'}
            {quotaMbRounded !== null ? ` / ${quotaMbRounded} MB` : ''}
          </span>
        </div>
        <div style={s.statusLine}>
          <span style={s.statusKey}>High / low watermark</span>
          <span style={s.statusVal}>{def.high_watermark_mb} / {def.low_watermark_mb} MB</span>
        </div>
      </div>

      <Toggle
        theme={theme}
        label="Archive cold pieces when over watermark"
        detail="When local storage exceeds the high watermark, upload cold + swarm-attested pieces to the URI backup and drop local bytes. Rehydrate on demand."
        checked={def.enabled}
        onChange={(enabled) => setDef((d) => ({ ...d, enabled }))}
      />

      <Row theme={theme} label="High watermark (MB)">
        <NumberInput
          theme={theme}
          value={def.high_watermark_mb}
          min={50}
          step={50}
          onChange={(n) => setDef((d) => ({ ...d, high_watermark_mb: n }))}
        />
      </Row>

      <Row theme={theme} label="Low watermark (MB)">
        <NumberInput
          theme={theme}
          value={def.low_watermark_mb}
          min={0}
          step={50}
          onChange={(n) => setDef((d) => ({ ...d, low_watermark_mb: n }))}
        />
      </Row>

      <Row theme={theme} label="Min attestation">
        <NumberInput
          theme={theme}
          value={def.min_attestation}
          min={0}
          step={1}
          onChange={(n) => setDef((d) => ({ ...d, min_attestation: n }))}
        />
      </Row>

      <Row theme={theme} label="Hot window (hours)">
        <NumberInput
          theme={theme}
          value={hotHours}
          min={0}
          step={1}
          onChange={(h) => setDef((d) => ({ ...d, hot_window_ms: h * 3_600_000 }))}
        />
      </Row>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          disabled={!canSave || saving}
          onClick={save}
          style={{
            ...s.saveButton,
            opacity: !canSave || saving ? 0.5 : 1,
            cursor: !canSave || saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save retention policy'}
        </button>
        {saveError ? (
          <span style={{ ...s.statusVal, color: theme.danger }}>{saveError}</span>
        ) : null}
      </div>

      {!canSave && loaded ? (
        <div style={{ ...s.statusVal, color: theme.warning, marginTop: 8 }}>
          Low watermark must be strictly less than the high watermark.
        </div>
      ) : null}
    </>
  );
}

function pickDefFields(v: Partial<CacheDefOperand>): Partial<CacheDefOperand> {
  const out: Partial<CacheDefOperand> = {};
  if (typeof v.enabled === 'boolean') out.enabled = v.enabled;
  if (typeof v.high_watermark_mb === 'number') out.high_watermark_mb = v.high_watermark_mb;
  if (typeof v.low_watermark_mb === 'number') out.low_watermark_mb = v.low_watermark_mb;
  if (typeof v.min_attestation === 'number') out.min_attestation = v.min_attestation;
  if (typeof v.hot_window_ms === 'number') out.hot_window_ms = v.hot_window_ms;
  return out;
}

function Toggle({ theme, label, detail, checked, onChange }: {
  theme: Theme;
  label: string;
  detail: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const trackBg = checked ? theme.accent : theme.bgMuted;
  const knobColor = checked ? '#fff' : theme.textMuted;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0' }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          width: 30,
          height: 16,
          borderRadius: 999,
          background: trackBg,
          border: `1px solid ${checked ? theme.accent : theme.border}`,
          position: 'relative' as const,
          cursor: 'pointer',
          flexShrink: 0,
          marginTop: 3,
          padding: 0,
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        <span
          style={{
            position: 'absolute' as const,
            top: 1,
            left: checked ? 15 : 1,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: knobColor,
            transition: 'left 0.15s',
          }}
        />
      </button>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600, color: theme.text }}>
          {label}
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted, wordBreak: 'break-word' as const }}>
          {detail}
        </span>
      </div>
    </div>
  );
}

function Row({ theme, label, children }: { theme: Theme; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', gap: 10 }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>{label}</span>
      {children}
    </div>
  );
}

function NumberInput({ theme, value, min, step, onChange }: {
  theme: Theme;
  value: number;
  min: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        color: theme.text,
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        padding: '4px 8px',
        width: 100,
        textAlign: 'right' as const,
      }}
    />
  );
}

function inlineStyles(theme: Theme): Record<string, React.CSSProperties> {
  return {
    status: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
      padding: '6px 8px',
      marginBottom: 10,
      border: `1px solid ${theme.border}`,
      borderRadius: 4,
      background: theme.bgMuted,
    },
    statusLine: {
      display: 'flex',
      justifyContent: 'space-between',
    },
    statusKey: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: theme.textMuted,
    },
    statusVal: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: theme.text,
    },
    saveButton: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      color: '#fff',
      background: theme.accent,
      border: `1px solid ${theme.accent}`,
      borderRadius: 4,
      padding: '6px 14px',
    },
  };
}
