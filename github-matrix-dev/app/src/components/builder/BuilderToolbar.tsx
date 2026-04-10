import { useState, useEffect } from 'react';
import { useBuilderStore, type BuilderMode } from '../../store/builder-store';
import { useEoStore } from '../../store/eo-store';
import { useTheme, type Theme } from '../../theme';
import { formatName } from '../scope-picker-utils';
import { ScopePicker } from '../ScopePicker';
import { useHashRoute } from '../../lib/router';
import type { PageType } from '../../blocks/types';
import type { UserTypeDefinition } from '../../permissions/types';

interface BuilderToolbarProps {
  onBack: () => void;
}

export function BuilderToolbar({ onBack }: BuilderToolbarProps) {
  const viewName = useBuilderStore((s) => s.viewName);
  const viewId = useBuilderStore((s) => s.viewId);
  const mode = useBuilderStore((s) => s.mode);
  const isDirty = useBuilderStore((s) => s.isDirty);
  const pageType = useBuilderStore((s) => s.pageType);
  const recordSource = useBuilderStore((s) => s.recordSource);
  const previewRecordTarget = useBuilderStore((s) => s.previewRecordTarget);
  const visibleToTypes = useBuilderStore((s) => s.visibleToTypes);
  const setMode = useBuilderStore((s) => s.setMode);
  const setPreviewRecordTarget = useBuilderStore((s) => s.setPreviewRecordTarget);
  const setVisibleToTypes = useBuilderStore((s) => s.setVisibleToTypes);
  const getViewDefinition = useBuilderStore((s) => s.getViewDefinition);
  const markClean = useBuilderStore((s) => s.markClean);
  const dispatch = useEoStore((s) => s.dispatch);
  const getState = useEoStore((s) => s.getState);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const { route } = useHashRoute();
  const selectedSpace = route.space;
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);
  const [showVisibilityPicker, setShowVisibilityPicker] = useState(false);
  const [typeDefs, setTypeDefs] = useState<UserTypeDefinition[]>([]);

  // Load user type definitions from the current space state so the visibility
  // picker can list them. Refetches whenever the space changes or a new event
  // lands (lastSeq).
  useEffect(() => {
    let cancelled = false;
    if (!selectedSpace) {
      setTypeDefs([]);
      return;
    }
    getState(selectedSpace).then((state) => {
      if (cancelled) return;
      const defs = (state?.value?._user_type_definitions as UserTypeDefinition[] | undefined) ?? [];
      setTypeDefs(defs);
    }).catch(() => {
      if (!cancelled) setTypeDefs([]);
    });
    return () => { cancelled = true; };
  }, [selectedSpace, getState, lastSeq]);

  const handleSave = async () => {
    if (!viewId) return;
    const definition = getViewDefinition();
    await dispatch({
      op: 'DEF',
      target: `views.${viewId}`,
      operand: definition,
      agent: 'builder',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    });
    markClean();
  };

  return (
    <div style={s.toolbar}>
      <div style={s.left}>
        <button style={s.backBtn} onClick={onBack} title="Back to view list">
          ←
        </button>
        <span style={s.viewName}>{viewName}</span>
        {/* Page type badge */}
        <span style={{
          fontSize: 9,
          fontWeight: 600,
          textTransform: 'uppercase' as const,
          padding: '2px 6px',
          borderRadius: 4,
          background: pageType === 'record' ? '#E6F1FB' : pageType === 'list' ? '#FFF3E0' : `${theme.border}80`,
          color: pageType === 'record' ? '#185FA5' : pageType === 'list' ? '#E65100' : theme.textMuted,
        }}>
          {pageType}
          {recordSource?.scope && ` · ${formatName(recordSource.scope.split('.').pop() || '')}`}
        </span>
        {isDirty && <span style={s.dirtyDot} title="Unsaved changes" />}
      </div>

      <div style={s.center}>
        <div style={s.modeToggle}>
          <button
            style={{
              ...s.modeBtn,
              ...(mode === 'build' ? s.modeBtnActive : {}),
            }}
            onClick={() => setMode('build')}
          >
            Build
          </button>
          <button
            style={{
              ...s.modeBtn,
              ...(mode === 'live' ? s.modeBtnActive : {}),
            }}
            onClick={() => setMode('live')}
          >
            Live
          </button>
        </div>
      </div>

      <div style={s.right}>
        {/* Preview with record — for record pages */}
        {pageType === 'record' && (
          <div style={{ position: 'relative' as const }}>
            <button
              style={{
                ...s.previewBtn,
                ...(previewRecordTarget ? { borderColor: theme.accent, color: theme.accent } : {}),
              }}
              onClick={() => setShowPreviewPicker(!showPreviewPicker)}
              title="Preview with a specific record"
            >
              {previewRecordTarget
                ? `@ ${formatName(previewRecordTarget.split('.').pop() || '')}`
                : 'Preview with record'}
            </button>
            {showPreviewPicker && (
              <div style={{
                position: 'absolute' as const, top: '100%', right: 0,
                marginTop: 4, zIndex: 50, minWidth: 280,
              }}>
                <ScopePicker
                  value={previewRecordTarget ? { mode: 'hierarchy', target: previewRecordTarget } : undefined}
                  onChange={(binding) => {
                    if (binding.target) {
                      setPreviewRecordTarget(binding.target);
                    }
                    setShowPreviewPicker(false);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {typeDefs.length > 0 && (
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setShowVisibilityPicker(!showVisibilityPicker)}
              title="Which personas can see this view"
              style={{
                ...s.previewBtn,
                ...(visibleToTypes && visibleToTypes.length > 0
                  ? { borderColor: theme.accent, color: theme.accent }
                  : {}),
              }}
            >
              {visibleToTypes && visibleToTypes.length > 0
                ? `${visibleToTypes.length} persona${visibleToTypes.length !== 1 ? 's' : ''}`
                : 'All personas'}
            </button>
            {showVisibilityPicker && (
              <div style={{
                position: 'absolute' as const, top: '100%', right: 0,
                marginTop: 4, zIndex: 50, minWidth: 220,
                background: theme.bgCard,
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                boxShadow: theme.shadow,
                padding: 8,
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10, fontWeight: 600, color: theme.textSecondary,
                  marginBottom: 6,
                }}>
                  Visible to personas
                </div>
                <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 8 }}>
                  Leave all unchecked = visible to everyone
                </div>
                {typeDefs.map((def) => {
                  const checked = !!visibleToTypes && visibleToTypes.includes(def.id);
                  return (
                    <label key={def.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = visibleToTypes ?? [];
                          const next = checked
                            ? current.filter((id) => id !== def.id)
                            : [...current, def.id];
                          setVisibleToTypes(next.length > 0 ? next : undefined);
                        }}
                        style={{ accentColor: def.color || theme.accent }}
                      />
                      <span style={{
                        fontSize: 11, color: theme.text,
                        fontFamily: "'Outfit', sans-serif",
                      }}>
                        {def.label}
                      </span>
                      {def.color && (
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: def.color,
                        }} />
                      )}
                    </label>
                  );
                })}
                {visibleToTypes && visibleToTypes.length > 0 && (
                  <button
                    onClick={() => setVisibleToTypes(undefined)}
                    style={{
                      marginTop: 6, width: '100%',
                      padding: '4px 8px', fontSize: 10,
                      background: 'none', border: `1px solid ${theme.border}`,
                      borderRadius: 4, cursor: 'pointer',
                      color: theme.textMuted,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    clear restriction
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <button
          style={{
            ...s.saveBtn,
            opacity: isDirty ? 1 : 0.5,
          }}
          onClick={handleSave}
          disabled={!isDirty}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 12px',
      height: 40,
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    left: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    center: {
      display: 'flex',
      alignItems: 'center',
    },
    right: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      cursor: 'pointer',
      color: t.textSecondary,
      padding: '4px 8px',
      borderRadius: 4,
    },
    viewName: {
      fontFamily: "'Outfit', sans-serif",
      fontSize: 14,
      fontWeight: 500,
      color: t.text,
    },
    dirtyDot: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: t.warning,
    },
    modeToggle: {
      display: 'flex',
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      overflow: 'hidden',
    },
    modeBtn: {
      padding: '4px 14px',
      fontSize: 12,
      fontWeight: 500,
      border: 'none',
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    },
    modeBtnActive: {
      background: t.accent,
      color: '#fff',
    },
    previewBtn: {
      padding: '4px 10px',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    },
    saveBtn: {
      padding: '5px 16px',
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.accent}`,
      borderRadius: 6,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    },
  };
}
