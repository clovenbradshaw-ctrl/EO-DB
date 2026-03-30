import { useState } from 'react';
import { useBuilderStore, type BuilderMode } from '../../store/builder-store';
import { useEoStore } from '../../store/eo-store';
import { useTheme, type Theme } from '../../theme';
import { formatName } from '../scope-picker-utils';
import { ScopePicker } from '../ScopePicker';
import type { PageType } from '../../blocks/types';

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
  const setMode = useBuilderStore((s) => s.setMode);
  const setPreviewRecordTarget = useBuilderStore((s) => s.setPreviewRecordTarget);
  const getViewDefinition = useBuilderStore((s) => s.getViewDefinition);
  const markClean = useBuilderStore((s) => s.markClean);
  const dispatch = useEoStore((s) => s.dispatch);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);

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
