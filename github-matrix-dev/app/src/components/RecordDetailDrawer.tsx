import { useEffect, useState } from 'react';
import { RecordView } from './RecordView';
import { formatName } from './scope-picker-utils';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { LayoutDisplayType } from './detail-layout';

interface RecordDetailDrawerProps {
  target: string;
  onClose: () => void;
  onNavigate: (target: string) => void;
  profileFields?: string[];
  isMobile?: boolean;
  layoutType?: LayoutDisplayType;
}

/** Extract initials from a display name (e.g. "Priya Chandrasekaran" -> "PC") */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Extract entity type from target path (e.g. "import.clients.CLI-001" -> "client") */
function getEntityType(target: string): string {
  const parts = target.split('.');
  if (parts.length >= 2) {
    let collection = parts[parts.length - 2];
    // Singularize: remove trailing 's'
    if (collection.endsWith('s') && collection.length > 1) {
      collection = collection.slice(0, -1);
    }
    return collection.toLowerCase();
  }
  return 'record';
}

/** Extract entity ID from target path (e.g. "import.clients.CLI-001" -> "CLI-001") */
function getEntityId(target: string): string {
  return target.split('.').pop() || target;
}

const TYPE_COLORS: Record<string, string> = {
  client: '#c2700a',
  case: '#16a34a',
  attorney: '#7c5cbf',
  document: '#8b6834',
  billing_account: '#1a6dd4',
  contact: '#c2700a',
  matter: '#0e8a6e',
  task: '#1a6dd4',
  event: '#d9487a',
  note: '#7c5cbf',
};

export function RecordDetailDrawer({ target, onClose, onNavigate, profileFields, isMobile, layoutType }: RecordDetailDrawerProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const horizon = useEoStore((s) => s.horizon);
  const ready = useEoStore((s) => s.ready);
  const [recordName, setRecordName] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    horizon(target)
      .then((result) => {
        if (cancelled) return;
        if (result && !Array.isArray(result) && result.figure?.value?.name) {
          setRecordName(result.figure.value.name);
        }
      })
      .catch(() => { /* header falls back to formatted ID */ });
    return () => { cancelled = true; };
  }, [ready, target, horizon]);

  const displayName = recordName || formatName(target.split('.').pop() || '');
  const entityType = getEntityType(target);
  const entityId = getEntityId(target);
  const initials = getInitials(displayName);
  const typeColor = TYPE_COLORS[entityType] || '#7a756d';
  const isFullModal = !isMobile && layoutType === 'modal';

  const panelStyle: React.CSSProperties = isFullModal
    ? {
        ...s.panel,
        position: 'fixed' as const,
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '90vw',
        maxWidth: 1100,
        height: '85vh',
        borderRadius: 12,
        borderLeft: 'none',
        border: `1px solid ${theme.border}`,
        boxShadow: `0 8px 30px ${theme.shadow}`,
        zIndex: 1001,
      }
    : {
        ...s.panel,
        ...(isMobile ? {
          width: '100vw', maxWidth: '100vw',
          position: 'fixed' as const, inset: 0, zIndex: 1000,
          borderLeft: 'none',
        } : {}),
      };

  return (
    <>
      {isFullModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
          }}
          onClick={onClose}
        />
      )}
      <div style={panelStyle}>
        <div style={s.header}>
          {isMobile && (
            <button onClick={onClose} style={s.backBtn}>{'\u2190'} Back</button>
          )}
          <div style={s.headerContent}>
            <div style={{ ...s.avatar, background: `${typeColor}20`, color: typeColor }}>
              {initials}
            </div>
            <div style={s.headerInfo}>
              <div style={s.headerName}>{displayName}</div>
              <div style={s.headerMeta}>
                <span style={{ ...s.typeBadge, background: `${typeColor}15`, color: typeColor }}>
                  <span style={{ ...s.typeDot, background: typeColor }} />
                  {entityType}
                </span>
                <span style={s.entityIdLabel}>{entityId}</span>
              </div>
            </div>
          </div>
          {!isMobile && <button onClick={onClose} style={s.closeBtn}>&times;</button>}
        </div>
        <div style={s.body}>
          <RecordView target={target} onNavigate={onNavigate} profileFields={profileFields} />
        </div>
      </div>
    </>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    panel: {
      width: 640,
      maxWidth: '55vw',
      minWidth: 320,
      height: '100%',
      flexShrink: 0,
      background: t.bg,
      borderLeft: `1px solid ${t.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      padding: '20px 24px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    headerContent: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      flex: 1,
      minWidth: 0,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 15,
      fontWeight: 600,
      flexShrink: 0,
    },
    headerInfo: {
      flex: 1,
      minWidth: 0,
    },
    headerName: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 20,
      fontWeight: 600,
      color: t.textHeading,
      lineHeight: 1.2,
    },
    headerMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 4,
    },
    typeBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 500,
    },
    typeDot: {
      width: 6,
      height: 6,
      borderRadius: '50%',
    },
    entityIdLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      fontSize: 13,
      fontWeight: 500,
      color: t.accent,
      cursor: 'pointer',
      padding: '4px 8px',
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 22,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
    },
    body: {
      flex: 1,
      overflowY: 'auto',
      overflowX: 'hidden',
    },
  };
}
