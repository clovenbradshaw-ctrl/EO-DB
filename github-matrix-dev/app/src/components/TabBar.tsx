import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { useTheme, type Theme } from '../theme';
import { useTabsStore, type Tab } from '../store/tabs-store';

const mono = "'JetBrains Mono', ui-monospace, monospace";

interface TabBarProps {
  /** Called when the active tab changes. Layout syncs the route here. */
  onActivate: (tab: Tab) => void;
  /** Called when "+" is pressed. Defaults to opening a records tab. */
  onNewTab?: () => void;
}

/**
 * Chrome-style tab strip rendered above the main content. The tabs store is
 * the source of truth; this component is purely a controlled view of it.
 */
export function TabBar({ onActivate, onNewTab }: TabBarProps) {
  const { theme } = useTheme();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const moveTab = useTabsStore((s) => s.moveTab);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const s = styles(theme);

  function handleActivate(tab: Tab) {
    if (tab.id === activeTabId) return;
    setActiveTab(tab.id);
    onActivate(tab);
  }

  function handleClose(e: MouseEvent, tab: Tab) {
    e.stopPropagation();
    e.preventDefault();
    const wasActive = tab.id === activeTabId;
    closeTab(tab.id);
    if (wasActive) {
      // Activate whatever the store promoted to the active slot.
      const nextId = useTabsStore.getState().activeTabId;
      const next = useTabsStore.getState().tabs.find((t) => t.id === nextId);
      if (next) onActivate(next);
    }
  }

  function handleMiddleClick(e: MouseEvent, tab: Tab) {
    if (e.button === 1) {
      e.preventDefault();
      handleClose(e, tab);
    }
  }

  function handleDragStart(e: DragEvent, id: string) {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires setData for drag to start
    e.dataTransfer.setData('text/plain', id);
  }
  function handleDragOver(e: DragEvent, index: number) {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(index);
  }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    if (dragId && dropIndex != null) moveTab(dragId, dropIndex);
    setDragId(null);
    setDropIndex(null);
  }
  function handleDragEnd() {
    setDragId(null);
    setDropIndex(null);
  }

  if (tabs.length === 0) return null;

  return (
    <div style={s.strip} ref={stripRef} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeTabId;
        const isDragging = tab.id === dragId;
        const showLeftIndicator = dropIndex === idx && dragId && dragId !== tab.id;
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => handleDragStart(e, tab.id)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDragEnd={handleDragEnd}
            onClick={() => handleActivate(tab)}
            onAuxClick={(e) => handleMiddleClick(e, tab)}
            style={{
              ...s.tab,
              ...(isActive ? s.tabActive : s.tabInactive),
              ...(isDragging ? { opacity: 0.55 } : {}),
            }}
            title={`${tab.title}${tab.space ? `\nSpace: ${tab.space}` : ''}`}
          >
            {showLeftIndicator && <span style={s.dropIndicator} />}
            <span style={s.tabIcon}>{tab.icon}</span>
            <span style={s.tabTitle}>{tab.title}</span>
            {tabs.length > 1 && (
              <button
                onClick={(e) => handleClose(e, tab)}
                onMouseDown={(e) => e.stopPropagation()}
                style={s.closeBtn}
                title="Close tab (middle-click)"
                aria-label={`Close ${tab.title}`}
              >
                {'\u00D7'}
              </button>
            )}
          </div>
        );
      })}
      <button
        onClick={() => onNewTab?.()}
        style={s.newTabBtn}
        title="New tab"
        aria-label="New tab"
      >
        {'+'}
      </button>
      <div style={s.stripFiller} />
    </div>
  );
}

function styles(theme: Theme): Record<string, CSSProperties> {
  const stripBg = theme.mode === 'light' ? theme.bgMuted : theme.bg;
  const inactiveBg = theme.mode === 'light' ? theme.bgHover : theme.bgCard;
  const activeBg = theme.bgCard;
  return {
    strip: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 2,
      padding: '6px 10px 0 10px',
      background: stripBg,
      borderBottom: `1px solid ${theme.border}`,
      flexShrink: 0,
      overflowX: 'auto',
      scrollbarWidth: 'thin',
      minHeight: 36,
    },
    tab: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px 7px 12px',
      maxWidth: 220,
      minWidth: 90,
      borderTopLeftRadius: 8,
      borderTopRightRadius: 8,
      borderBottom: 'none',
      fontFamily: mono,
      fontSize: 12,
      cursor: 'pointer',
      userSelect: 'none',
      transition: 'background 120ms ease, color 120ms ease',
      whiteSpace: 'nowrap',
    },
    tabActive: {
      background: activeBg,
      color: theme.text,
      border: `1px solid ${theme.border}`,
      borderBottom: `1px solid ${activeBg}`,
      marginBottom: -1,
      fontWeight: 600,
      boxShadow: `0 -1px 2px ${theme.shadow}`,
      zIndex: 2,
    },
    tabInactive: {
      background: inactiveBg,
      color: theme.textSecondary,
      border: `1px solid transparent`,
      borderBottom: `1px solid ${theme.border}`,
      opacity: 0.9,
    },
    tabIcon: {
      fontSize: 11,
      opacity: 0.7,
      flexShrink: 0,
    },
    tabTitle: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    closeBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 16,
      height: 16,
      borderRadius: 4,
      border: 'none',
      background: 'transparent',
      color: theme.textMuted,
      fontSize: 14,
      lineHeight: 1,
      cursor: 'pointer',
      padding: 0,
      flexShrink: 0,
    },
    newTabBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 26,
      height: 26,
      marginBottom: 2,
      marginLeft: 4,
      borderRadius: 6,
      border: 'none',
      background: 'transparent',
      color: theme.textSecondary,
      fontSize: 16,
      lineHeight: 1,
      cursor: 'pointer',
      padding: 0,
      flexShrink: 0,
    },
    stripFiller: {
      flex: 1,
      borderBottom: `1px solid ${theme.border}`,
      alignSelf: 'stretch',
    },
    dropIndicator: {
      position: 'absolute',
      left: -1,
      top: 4,
      bottom: 0,
      width: 2,
      background: theme.accent,
      borderRadius: 2,
      pointerEvents: 'none',
    },
  };
}
