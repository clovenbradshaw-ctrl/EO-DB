/**
 * UserTypeSwitcher — header dropdown to select the active user type.
 *
 * If user has 0 types: not rendered (parent should conditionally render).
 * If user has 1 type: shows badge only (no dropdown).
 * If user has 2+ types: shows dropdown switcher.
 */

import { useState, useEffect, useRef } from 'react';
import { useTheme, type Theme } from '../theme';
import type { UserTypeDefinition } from '../permissions/types';
import { UserTypeBadge } from './UserTypeBadge';

interface UserTypeSwitcherProps {
  /** All type definitions for the current space */
  typeDefinitions: UserTypeDefinition[];
  /** Type IDs assigned to the current user */
  assignedTypeIds: string[];
  /** Currently active type ID */
  activeTypeId: string | null;
  /** Callback when user selects a type */
  onSelect: (typeId: string | null) => void;
}

export function UserTypeSwitcher({
  typeDefinitions,
  assignedTypeIds,
  activeTypeId,
  onSelect,
}: UserTypeSwitcherProps) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mono = "'JetBrains Mono', monospace";

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Resolve assigned types to definitions
  const assignedTypes = assignedTypeIds
    .map(id => typeDefinitions.find(d => d.id === id))
    .filter((d): d is UserTypeDefinition => d != null);

  if (assignedTypes.length === 0) return null;

  const activeType = activeTypeId
    ? typeDefinitions.find(d => d.id === activeTypeId) ?? null
    : null;

  // Auto-select first type if none active
  useEffect(() => {
    if (!activeTypeId && assignedTypes.length > 0) {
      onSelect(assignedTypes[0].id);
    }
  }, [activeTypeId, assignedTypes.length]);

  // Single type — just show badge, no dropdown
  if (assignedTypes.length === 1) {
    return (
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <UserTypeBadge
          label={assignedTypes[0].label}
          color={assignedTypes[0].color}
        />
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          background: open ? theme.bgHover : 'transparent',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          fontFamily: mono,
          fontSize: 11,
          color: theme.textSecondary,
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = theme.bgHover;
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        {activeType ? (
          <UserTypeBadge label={activeType.label} color={activeType.color} compact />
        ) : (
          <span style={{ color: theme.textMuted }}>Select role</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 4L5 6.5L7.5 4" stroke={theme.textMuted} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          boxShadow: `0 8px 24px ${theme.shadow}`,
          minWidth: 200,
          zIndex: 200,
          overflow: 'hidden',
          padding: '4px 0',
        }}>
          {assignedTypes.map((t) => {
            const isActive = activeTypeId === t.id;
            return (
              <button
                key={t.id}
                onClick={() => { onSelect(t.id); setOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  textAlign: 'left' as const,
                  padding: '8px 12px',
                  background: isActive ? theme.accentBg : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: mono,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = theme.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isActive ? theme.accentBg : 'transparent';
                }}
              >
                <div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: t.color || '#6b7280',
                      flexShrink: 0,
                    }} />
                    <span style={{
                      fontSize: 11,
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? theme.accent : theme.text,
                    }}>
                      {t.label}
                    </span>
                  </div>
                  {t.description && (
                    <div style={{
                      fontSize: 9,
                      color: theme.textMuted,
                      marginTop: 2,
                      marginLeft: 14,
                    }}>
                      {t.description}
                    </div>
                  )}
                </div>
                {isActive && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7.5L5.5 10L11 4" stroke={theme.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
