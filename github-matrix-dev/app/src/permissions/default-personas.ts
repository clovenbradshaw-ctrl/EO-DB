/**
 * Default law-firm personas seeded when a new EO-DB space is created.
 *
 * These are starter definitions for an immigration-focused law firm. They
 * cover the five canonical functional roles (Attorney, Paralegal, Intake
 * Coordinator, Billing Specialist, Managing Partner) and come pre-wired
 * with colors, labels, base_role capability caps, nav restrictions, and
 * terminology overrides. Home destinations, default slices, and quick
 * actions are deliberately omitted because they reference scopes and
 * slices that don't exist in a brand-new space — the firm admin fills
 * those in after setting up the tables.
 *
 * Seeding runs once at space creation (see Layout.tsx#onCreate) and
 * writes a DEF event with _user_type_definitions onto the space target.
 * After that, the firm admin owns the list via UserTypeManager.
 *
 * The seed is EDITABLE — admins can rename, delete, or extend any of
 * these personas via UserTypeManager. They are defaults, not hardcoded
 * behavior.
 */

import type { UserTypeDefinition } from './types';

export const DEFAULT_LAW_FIRM_PERSONAS: UserTypeDefinition[] = [
  {
    id: 'attorney',
    label: 'Attorney',
    color: '#3b82f6',
    description: 'Case strategy, client representation, billable work',
    base_role: 'editor',
    terminology: {
      record: 'case',
      records: 'Cases',
    },
  },
  {
    id: 'paralegal',
    label: 'Paralegal',
    color: '#8b5cf6',
    description: 'Form prep, evidence collection, filing deadlines',
    base_role: 'editor',
    visible_views: ['records', 'messages', 'import'],
    terminology: {
      record: 'filing',
      records: 'Filings',
    },
  },
  {
    id: 'intake_coordinator',
    label: 'Intake Coordinator',
    color: '#10b981',
    description: 'New client intake, eligibility screening, consultations',
    base_role: 'creator',
    visible_views: ['records', 'people'],
    terminology: {
      record: 'consultation',
      records: 'Consultations',
    },
  },
  {
    id: 'billing_specialist',
    label: 'Billing Specialist',
    color: '#f59e0b',
    description: 'Time tracking, invoicing, trust accounting, payments',
    base_role: 'editor',
    visible_views: ['records', 'log'],
    terminology: {
      record: 'time entry',
      records: 'Time Entries',
    },
  },
  {
    id: 'managing_partner',
    label: 'Managing Partner',
    color: '#ef4444',
    description: 'Firm-wide oversight, staff management, settings',
    base_role: 'admin',
    // No visible_views restriction — partners see everything.
    // No terminology override — partners use canonical labels.
  },
];
