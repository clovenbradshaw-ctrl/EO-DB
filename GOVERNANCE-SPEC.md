# EO-DB Governance & Access Control Spec

## Context

EO-DB currently has a basic 3-tier sharing model at the space level (`read` / `write` / `admin`) stored in `_sharing` on the space target value (`SpaceMembers.tsx`). The server-side `matrix-auth-config.ts` has a 4-layer system (accounts, blacklist, server rules, user-rule buckets) but it operates at the database-instance level, not within individual spaces.

**Problem:** There's no way for users to control who can create fields, who can edit specific columns, who can add records, or who can build views/pages within a space. The current 3-tier model is too coarse for real collaboration.

**Goal:** A governance model that feels familiar (Google Docs, Drive, Canva, Airtable) while using **Matrix power levels as the source of truth** for roles, **Matrix rooms as permission boundaries** for data access, and **segment key distribution as read-access control**. No application-level trust — if you can't read it, you're not in the room and don't have the key.

---

## 1. Permission Model — Matrix-Native, 5 Roles

### Core Principle: Matrix Is the Permission Layer

Instead of storing permissions in `_sharing` and enforcing in the fold (application-level, bypassable), EO-DB roles map directly to **Matrix power levels**:

- **Power levels** = who can send what event types (write access)
- **Room membership** = who can receive events (download access)
- **Segment keys** = who can decrypt field values (read access)
- **Room topology** = what data lives where (isolation boundaries)

If someone shouldn't read data, it lives in a room they're not in, encrypted with a key they don't have. No trust required — it's cryptographic.

### Comparable Systems Reference

| Platform | Roles | Granularity |
|----------|-------|-------------|
| **Google Docs** | Owner, Editor, Commenter, Viewer | Document-level |
| **Google Drive** | Manager, Content Manager, Contributor, Commenter, Viewer | Folder cascading |
| **Canva** | Owner, Admin, Template Editor, Member, Viewer + "Can share" toggle | Team/folder |
| **Airtable** | Owner, Creator, Editor, Commenter, Read-only + per-field locks | Base/table/field |
| **Notion** | Full access, Can edit, Can comment, Can view + page locks | Page/database |

### EO-DB Roles → Matrix Power Levels

```
Owner (100) > Admin (50) > Editor (25) > Creator (10) > Viewer (0)
```

| Role | Label (UI) | Matrix PL | Description | Familiar Comp |
|------|-----------|-----------|-------------|---------------|
| `owner` | **Owner** | 100 | Full control, manage rooms, manage keys, delete space | Google Drive Owner |
| `admin` | **Full access** | 50 | Manage people (invite/kick), create/modify fields, set policies, build views | Google Drive Manager |
| `editor` | **Can edit** | 25 | Edit any record's fields, add/remove records, create relationships | Google Docs Editor |
| `creator` | **Can add** | 10 | Add new records, edit only records they created | Airtable Creator |
| `viewer` | **Can view** | 0 | Read-only access to data they have keys for | Google Docs Viewer |

### Matrix Power Level Configuration (per room)

```yaml
power_levels:
  users_default: 0                    # new members start as Viewer
  events:
    # EO event types (custom Matrix event types)
    com.eo-db.event: 10               # Creator+ can submit EO events (INS, DEF on own)
    com.eo-db.schema: 50              # Admin+ can modify schema (new fields, field config)
    com.eo-db.governance: 50          # Admin+ can set EVA policies
    com.eo-db.key.announce: 100       # Owner only can announce segment keys
    com.eo-db.snapshot: 50            # Admin+ can create snapshots
    # Matrix built-ins
    m.room.name: 100                  # Only owner can rename room
    m.room.power_levels: 100          # Only owner can change power levels
  invite: 50                          # Admin+ can invite
  kick: 50                            # Admin+ can kick
  ban: 100                            # Only owner can ban
  state_default: 50                   # Admin+ can change room state
  events_default: 10                  # Creator+ can send custom events
```

**This means Matrix itself enforces permissions.** A Viewer (PL 0) literally cannot send `com.eo-db.event` events — the homeserver rejects them. No fold checks needed for write access.

### Capability Matrix

| Capability | Matrix Event Type | PL Required | Owner | Admin | Editor | Creator | Viewer |
|-----------|-------------------|-------------|-------|-------|--------|---------|--------|
| Read data (if in room + has key) | — | 0 | Y | Y | Y | Y | Y |
| Add records (INS) | `com.eo-db.event` | 10 | Y | Y | Y | Y | — |
| Edit any record (DEF) | `com.eo-db.event` | 10+fold | Y | Y | Y | — | — |
| Edit own records (DEF) | `com.eo-db.event` | 10+fold | Y | Y | Y | Y | — |
| Create relationships (CON) | `com.eo-db.event` | 10+fold | Y | Y | Y | — | — |
| Create new fields (schema) | `com.eo-db.schema` | 50 | Y | Y | — | — | — |
| Set governance policies (EVA) | `com.eo-db.governance` | 50 | Y | Y | — | — | — |
| Build views/pages | `com.eo-db.schema` | 50 | Y | Y | — | — | — |
| Invite/kick members | Matrix invite/kick | 50 | Y | Y | — | — | — |
| Manage segment keys | `com.eo-db.key.announce` | 100 | Y | — | — | — | — |
| Change power levels | `m.room.power_levels` | 100 | Y | — | — | — | — |
| Delete space | Room admin | 100 | Y | — | — | — | — |

**Note on Creator vs Editor:** Both have PL 10 and can send `com.eo-db.event`. The distinction between "edit any" vs "edit own" requires a **thin fold-layer check**: when a Creator submits a DEF on a record they didn't create, the fold rejects it. This is the *only* application-level permission check needed — everything else is Matrix-native.

### "Can share" Toggle (Canva-style)

Admins (PL 50+) can invite to the room. Optionally, an admin can temporarily elevate a user's PL to 50 to let them invite others, or use a separate "invite room" pattern.

---

## 2. Data Model — Multi-Room Topology

### Core Principle: Rooms = Permission Boundaries

Instead of one room for everything, a space maps to a **set of Matrix rooms** with different membership. Data is partitioned across rooms based on sensitivity. If you're not in the room, you never download the data. If you don't have the segment key, you can't read the fields even if you're in the room.

### 2a. Room Topology Per Space

Each space creates up to 3 rooms (only the first is required):

```
Space: "Client Tracker"
│
├── #client-tracker (main data room)
│     Membership: Owner, Admin, Editor, Creator, Viewer
│     Contains: Records, relationships (CON), basic fields
│     Power levels: See Section 1 mapping
│
├── #client-tracker.restricted (restricted fields room)
│     Membership: Owner, Admin (+ Editors granted access)
│     Contains: DEF events for sensitive fields (e.g., SSN, salary, internal notes)
│     Segment key: Distributed only to room members
│     Power levels: events_default: 25 (Editor+)
│
└── #client-tracker.governance (governance room)
      Membership: Owner, Admin only
      Contains: EVA policies, schema changes, field permission config, view/page definitions
      Power levels: events_default: 50 (Admin+)
```

**How field-level isolation works:**
- A record `app.tblClients.rec123` exists in the main room (INS event)
- Most fields are DEF'd in the main room: `fldName`, `fldEmail`, `fldStatus`
- Sensitive fields are DEF'd in the restricted room: `fldSSN`, `fldSalary`, `fldInternalNotes`
- A Viewer in the main room sees the record with basic fields. The restricted field **values** were never downloaded — but the field **names** are visible because the schema manifest is published to the main room (see below).
- An Admin in both rooms sees all fields merged together by the fold.

**Schema manifest (published to main room):** A room state event in the main room lists all field names and which room holds their data. This lets every member see the table structure (columns) even if they can't see the values. This is what powers redaction bars — the app knows a "SSN" column exists, but the values are in a room the user isn't in.

```typescript
// Room state event in main room: com.eo-db.schema.manifest
{
  type: 'com.eo-db.schema.manifest',
  state_key: '',
  content: {
    fields: [
      { name: 'fldName', room: 'main' },
      { name: 'fldEmail', room: 'main' },
      { name: 'fldStatus', room: 'main' },
      { name: 'fldSSN', room: 'restricted' },       // ← shows as redacted for non-members
      { name: 'fldSalary', room: 'restricted' },     // ← shows as redacted for non-members
    ]
  }
}
```

Only Admin+ (PL 50) can update this manifest (it's a state event with `state_default: 50`).

### 2b. Append-Only & Key Reality

**The append-only log means you can't retroactively revoke access to data someone already received.** You can't re-encrypt old events. You can't rotate keys on data that's already been written. This is inherent to E2EE + append-only — same constraint as Signal groups, Matrix itself, or any E2EE system.

| Scenario | What happens | Old data | New data |
|----------|-------------|----------|----------|
| User kicked from room | Megolm session rotates. Kicked user retains old session keys locally. | **Still readable** (old keys retained) | **Inaccessible** (new Megolm session, never shared) |
| Segment key for new scope | New events use new key. Old events keep old key. | **Still encrypted with old key** (can't re-encrypt) | **Encrypted with new key** (only current holders can read) |
| User's device wiped | IndexedDB cleared. Without room membership, can't re-sync. | **Gone** (no local copy, no room access to replay) | **Inaccessible** |

**What you CAN do:**
- Stop sharing new data by kicking from room → new Megolm session excludes them
- Start encrypting a field going forward with a new segment key → old values stay as-is, new values are encrypted
- Purge their local IndexedDB on kick detection → removes their local copy (but they could have exported it)

**What you CANNOT do:**
- Re-encrypt old events with new keys (append-only)
- Force-delete data from their device if they've already downloaded it
- Revoke Megolm keys that were already shared

**Implication for design:** The right strategy is to **put sensitive data in restricted rooms from the start**, not to retroactively protect it. The room topology IS the access control — it's proactive, not reactive. Design your rooms around the worst-case "who should EVER have seen this data" question, not "who should see it right now."

### 2c. Space Configuration (Room State Events)

Space-level config is stored as Matrix room state events in the governance room (readable by admins):

```typescript
// Custom state event: com.eo-db.space.config
{
  type: 'com.eo-db.space.config',
  state_key: '',
  content: {
    name: string;                          // Space display name
    rooms: {
      main: string;                        // Room ID for main data
      restricted?: string;                 // Room ID for restricted fields
      governance?: string;                 // Room ID for governance
    };
    field_assignments: FieldAssignment[];   // Which fields go to which room
    space_settings: SpaceSettings;
  }
}

interface FieldAssignment {
  field: string;               // field key (e.g., "fldSSN")
  room: 'main' | 'restricted'; // which room this field's DEF events go to
  locked_to?: AccessRole[];    // within that room, who can edit (fold-enforced)
}

interface SpaceSettings {
  creators_can_delete_own?: boolean;  // default: true
  lock_shared_views?: boolean;        // default: false
}
```

### 2d. Types

```typescript
type AccessRole = 'owner' | 'admin' | 'editor' | 'creator' | 'viewer';

// Power level mapping (stored as room state, read by the app)
const ROLE_POWER_LEVELS: Record<AccessRole, number> = {
  owner: 100,
  admin: 50,
  editor: 25,
  creator: 10,
  viewer: 0,
};

// Reverse lookup: power level → role label
function powerLevelToRole(pl: number): AccessRole {
  if (pl >= 100) return 'owner';
  if (pl >= 50) return 'admin';
  if (pl >= 25) return 'editor';
  if (pl >= 10) return 'creator';
  return 'viewer';
}

interface FieldPermission {
  field: string;
  room: 'main' | 'restricted';   // which room holds this field's data
  locked_to?: AccessRole[];       // within the room, further restrict editing
  set_by: string;
  set_at: string;
}
```

**Backward compatibility:**
- Old `'read'` → `'viewer'` (PL 0)
- Old `'write'` → `'editor'` (PL 25)
- Old `'admin'` → `'admin'` (PL 50)
- Existing single-room spaces continue to work — the restricted/governance rooms are optional

---

## 3. Permission Resolution

### Source of Truth: Matrix Power Levels

The app reads the user's power level directly from Matrix room state — no separate permission store needed:

```typescript
// --- permissions/resolve.ts ---

interface ResolvedPermissions {
  role: AccessRole;                    // derived from Matrix power level
  powerLevel: number;                  // raw Matrix PL
  is_owner: boolean;

  // Room membership (what data the user has access to)
  in_main_room: boolean;
  in_restricted_room: boolean;
  in_governance_room: boolean;

  // Capability flags (derived from power level)
  can_read: boolean;                   // always true if in room
  can_add_records: boolean;            // PL >= 10
  can_edit_any_record: boolean;        // PL >= 25
  can_edit_own_records: boolean;       // PL >= 10
  can_create_fields: boolean;          // PL >= 50
  can_build_views: boolean;            // PL >= 50
  can_manage_members: boolean;         // PL >= 50 (Matrix invite/kick)
  can_set_governance: boolean;         // PL >= 50
  can_manage_keys: boolean;            // PL >= 100
  can_share: boolean;                  // PL >= 50

  // Field-level (from field_assignments in space config)
  restricted_fields: string[];         // fields in restricted room (user may or may not have access)
  locked_fields: string[];             // fields user can see but not edit (locked_to override)
  redacted_fields: string[];           // fields user cannot see (not in room / no key)
}

function resolvePermissions(
  userId: string,
  mainRoom: Room,                      // Matrix Room object
  restrictedRoom?: Room | null,
  spaceConfig?: SpaceConfig,
): ResolvedPermissions {
  // 1. Read power level from Matrix room state
  const pl = mainRoom.getMember(userId)?.powerLevel ?? 0;
  const role = powerLevelToRole(pl);

  // 2. Check room membership
  const inRestricted = restrictedRoom?.getMember(userId)?.membership === 'join';

  // 3. Compute field access from field_assignments + room membership
  const restrictedFields = spaceConfig?.field_assignments
    ?.filter(f => f.room === 'restricted') ?? [];
  const redacted = restrictedFields
    .filter(() => !inRestricted)
    .map(f => f.field);

  // 4. Compute locked fields (within-room write restrictions)
  const locked = spaceConfig?.field_assignments
    ?.filter(f => f.locked_to && !f.locked_to.includes(role))
    .map(f => f.field) ?? [];

  // 5. Return capabilities derived from power level
  return { role, powerLevel: pl, is_owner: pl >= 100, ... };
}
```

**Key difference from application-level permissions:** The power level is not stored in EO state — it's read from Matrix room state (`m.room.power_levels`). This means:
- It can't be spoofed by sending fake EO events
- It's enforced by the Matrix homeserver (not just the client)
- Changes are immediate (no sync delay)

### Creator "own records" logic

The one fold-level check: a Creator (PL 10) can send `com.eo-db.event` but should only be able to DEF records they created. Resolution:
- On INS, the fold stores `_created_by: agent` in the record's value
- On DEF from a Creator-level agent, the fold checks `record.value._created_by === agent`
- If mismatch → reject the event (the only application-level permission check needed)

---

## 4. Enforcement — Three Layers

### Layer 1: Matrix Protocol (cryptographic, authoritative)

**This is the primary enforcement layer.** The Matrix homeserver enforces power levels before events are even distributed:

| Action | Matrix Enforcement |
|--------|--------------------|
| Viewer tries to send `com.eo-db.event` | Homeserver rejects — PL 0 < required PL 10 |
| Editor tries to send `com.eo-db.schema` | Homeserver rejects — PL 25 < required PL 50 |
| Editor tries to invite someone | Homeserver rejects — PL 25 < invite PL 50 |
| Admin tries to change power levels | Homeserver rejects — PL 50 < PL 100 |
| Viewer tries to read restricted room | Impossible — not a member, events never delivered |

**Cannot be bypassed.** The homeserver is the gatekeeper. Even a modified client can't submit events above its power level.

### Layer 2: Fold Enforcement (thin, for Creator distinction)

The **only** application-level check needed: Creator vs Editor distinction for record ownership.

```
On DEF event from agent with PL 10-24 (Creator):
  1. Read the target record's _created_by field
  2. If _created_by !== agent → reject event
  3. Otherwise → allow (Creator editing their own record)
```

Everything else (schema changes, governance, key management, invites) is already blocked at the Matrix layer.

### Layer 3: UI Enforcement (visual, UX)

The UI reads `resolvedPermissions` and adjusts what the user sees:

| UI Element | Behavior |
|-----------|----------|
| "Add record" button | Hidden for Viewer (PL < 10) |
| "Add field" / "+" column | Hidden for Editor/Creator/Viewer (PL < 50) |
| Field cell in table | Disabled + lock icon if field is `locked_to` and user's role not included |
| Redacted field (not in room / no key) | **Black redaction bar** in cell, column header still visible |
| Builder tab in sidebar | Hidden for PL < 50 |
| Settings tab | Hidden for PL < 50 |
| Members panel "Invite" bar | Hidden for PL < 50 |
| Compose view operator list | Filtered to event types the user's PL allows |
| Record delete in context menu | Hidden for Viewer; "own only" label for Creator |
| "View only" banner | Shown persistently at top for Viewer role (like Google Docs) |
| Role badge in top bar | Shows role label next to user name |

**Why UI enforcement too?** Matrix prevents the event from being sent, but the user experience should make it clear *before* they try. Disabled buttons with tooltips ("You need Editor access to edit records") are better than error messages after the fact.

---

## 5. UI Design

### 5a. Enhanced SpaceMembers Panel

Extends the existing `SpaceMembers.tsx` panel. **Key change:** roles are read from Matrix power levels (`room.getMember(userId).powerLevel`), not from `_sharing`. Changing a role calls `client.setPowerLevel(roomId, userId, newPL)`.

```
┌──────────────────────────────────────────────┐
│  Share "Client Tracker"                    ✕ │
├──────────────────────────────────────────────┤
│  [Add people by Matrix ID...]  [Can edit ▾]  │
│                                    [Invite]  │
├──────────────────────────────────────────────┤
│  People with access                      5   │
│                                              │
│  ● alice     server.com          Owner       │
│  ● bob       server.com     [Can edit ▾]     │
│  ● carol     other.com      [Can add  ▾]     │
│  ● dave      other.com      [Can view ▾]     │
│  ● eve       matrix.org     [Full access ▾]  │
│                                              │
├──────────────────────────────────────────────┤
│  ▸ Restricted fields                     2   │
│                                              │
│    SSN, Salary → restricted room             │
│    [eve, alice have access]                  │
│    [+ Add member to restricted room]         │
│                                              │
│  ▸ Field locks                           1   │
│                                              │
│    Status  Locked to: Owner, Admin           │
│    [+ Lock a field]                          │
└──────────────────────────────────────────────┘
```

**Role picker dropdown (maps to Matrix power levels):**

```
┌─────────────────────────────────────────┐
│  Owner          Full control (PL 100) ✓ │
│  Full access    Manage people (PL 50)   │
│  Can edit       Edit any record (PL 25) │
│  Can add        Add & edit own (PL 10)  │
│  Can view       View data only (PL 0)   │
├─────────────────────────────────────────┤
│  Remove from room                       │
└─────────────────────────────────────────┘
```

Changing a role triggers `client.setPowerLevel()` — Matrix handles enforcement immediately.

### 5b. Role Badge in Top Bar

Next to the user's name in the top bar, show their role in the current space:

```
EO///DB  [Client Tracker ▾]  [Members]  ──  seq:42 evt:38 tgt:12  ──  alice · Editor
```

For Viewer role, show a persistent banner below the top bar (like Google Docs):

```
┌──────────────────────────────────────────────┐
│ 🔒 View only — You can view but not edit     │
└──────────────────────────────────────────────┘
```

### 5c. Field Lock Indicators in TableView

**Locked field (user can see but not edit):**
```
┌───────────────┬──────────────┬─────────────────┬──────────┐
│ Name          │ Email        │ 🔒 Status       │ Priority │
├───────────────┼──────────────┼─────────────────┼──────────┤
│ Acme Corp     │ a@acme.com   │ ░░ active ░░    │ high     │
│ Beta Inc      │ b@beta.com   │ ░░ pending ░░   │ medium   │
└───────────────┴──────────────┴─────────────────┴──────────┘
```

**Redacted field (user has no access — black bars):**
```
┌───────────────┬──────────────┬─────────────────┬──────────┐
│ Name          │ Email        │ SSN             │ Priority │
├───────────────┼──────────────┼─────────────────┼──────────┤
│ Acme Corp     │ a@acme.com   │ ██████████████  │ high     │
│ Beta Inc      │ b@beta.com   │ ██████████████  │ medium   │
└───────────────┴──────────────┴─────────────────┴──────────┘
```

The black bar is a solid `#000` rectangle filling the cell, with a subtle tooltip on hover explaining "You don't have access to this field." Column header remains visible so users understand the schema structure — like a declassified document with redacted lines.

- Lock icon (🔒) in column header for locked fields (read-only for this user)
- Locked cells have a subtle tinted background and are non-interactive
- Tooltip on hover: "This field can only be edited by Owner and Admin"
- **Redacted fields**: When the app knows a field exists (from space config / schema in governance room) but the user lacks access to its data, show a **black redaction bar** (solid black rectangle) in the cell. Column header still shows the field name so users understand the data structure — like a declassified document with redacted lines. This appears when:
  - The field's data lives in a room the user isn't a member of (data never downloaded — column known from schema)
  - The field is encrypted with a segment key the user doesn't hold (encrypted blob transited but wasn't stored)
- Redaction bar tooltip: "You don't have access to this field"
- **Why show the column at all?** Because the schema (field names, types) is shared knowledge — it helps users understand the data structure and know what access to request. The *values* are what's protected, not the existence of the field

### 5d. Field Permissions Sub-Panel

A collapsible section inside SpaceMembers for managing per-field restrictions:

```
▾ Field permissions                                    3

  ┌──────────────────────────────────────────────────┐
  │  Status                                          │
  │  Editable by: [Owner ✕] [Admin ✕]     [+ role]  │
  │  Visible to:  Everyone                           │
  │                                    [Remove lock] │
  └──────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────┐
  │  Internal Notes                                  │
  │  Editable by: Owner, Admin, Editor               │
  │  Hidden from: [Viewer ✕] [Creator ✕]  [+ role]  │
  │                                    [Remove lock] │
  └──────────────────────────────────────────────────┘

  [+ Add field restriction]
```

The "Add field restriction" flow:
1. Click → shows a dropdown of all fields in the space (derived from existing records)
2. Select a field → creates an entry with default "locked to Owner + Admin"
3. Adjust roles and visibility as needed

---

## 6. Data Visibility & Encryption Integration

### How It Works: Room Membership = Download Boundary

Data isolation is real — not application-level filtering. You only receive events from rooms you're a member of. The Matrix homeserver enforces this:

```
Space: "Client Tracker"
│
├── Main Room (#client-tracker)
│     User is a member → sync-manager downloads events → fold processes → IndexedDB
│
├── Restricted Room (#client-tracker.restricted)
│     User is NOT a member → homeserver never delivers these events → data never touches device
│     User IS a member → events arrive → fold merges restricted fields into records
│
└── Governance Room (#client-tracker.governance)
      User is NOT a member → schema/policy events never arrive
      User IS a member → schema and governance visible in settings
```

**Within a room:** If a field is encrypted with a segment key the user doesn't hold, the encrypted blob arrives during sync but the app **does not persist it to IndexedDB**. It transits the device (Matrix SDK processes it) but the fold discards undecryptable values — they're never stored locally. If access is later granted (user receives the segment key), the data becomes available on the next sync or by replaying room history.

### Three states for a field from a user's perspective:

| State | Cause | What user sees | Data on device? |
|-------|-------|---------------|----------------|
| **Visible & editable** | Field in a room user belongs to, role allows editing | Normal cell | Yes |
| **Visible & locked** | Field in user's room, but `locked_to` excludes their role | Cell with lock icon, non-interactive | Yes |
| **Redacted** | Field is in a room user doesn't belong to (never downloaded), or encrypted with a key they don't have (transits device but not stored) | **Black redaction bar** (████) | No — not in IndexedDB |

### When access is granted

When an admin invites a user to the restricted room:
1. Matrix delivers the invite → user joins the room
2. Sync-manager begins receiving events from the new room
3. `history_visibility: shared` means they can paginate back through room history
4. The fold processes the newly-received events, merging restricted fields into existing records
5. Previously-redacted fields become visible — black bars disappear, real values appear

### When access is revoked

When an admin kicks a user from the restricted room:
1. Matrix stops delivering new events from that room
2. The app detects the membership change and **purges restricted-room data from IndexedDB**
3. Black redaction bars appear where restricted fields were
4. **Important:** The user may have cached/seen the data before removal. Append-only + E2EE means old Megolm keys are retained locally. This is an inherent limitation of E2EE — same as Signal, WhatsApp, or Matrix itself. You cannot un-share what was already shared.
5. **Mitigation:** For truly sensitive data, design the room topology proactively. Put SSNs and salaries in the restricted room from day one, with minimal membership.

### Segment Keys + Room Topology = Defense in Depth

Two complementary layers:

| Layer | What it does | Enforcement |
|-------|-------------|-------------|
| **Room membership** | Controls who downloads the events at all | Matrix protocol (homeserver enforced) |
| **Segment key (SEG)** | Controls who can decrypt field values within a room | Cryptographic (AES-256-GCM) |

Using both together: even if someone is in the restricted room, individual fields can be encrypted with segment keys only distributed to specific users. The Owner (PL 100) controls key announcement via `com.eo-db.key.announce` events.

```
Restricted Room members: Owner, Admin, 2 Editors
│
├── fldSalary → encrypted with key_salary (only Owner + Admin have key)
├── fldSSN → encrypted with key_pii (only Owner has key)
└── fldInternalNotes → unencrypted (all room members can read)
```

An Editor in the restricted room sees `fldInternalNotes` but sees black bars for `fldSalary` and `fldSSN` — they're in the room but don't have the decryption keys.

### Anti-Spoofing

**Permissions can't be faked** because:
1. **Power levels** are Matrix room state — only PL 100 (Owner) can change them. The homeserver enforces this.
2. **Room membership** is controlled by Matrix invite/kick — only PL 50+ (Admin) can invite/kick.
3. **Segment keys** are announced via `com.eo-db.key.announce` — only PL 100 (Owner) can send these events.
4. **Event sender** (`agent`) is authenticated by the Matrix homeserver and verified by the SDK. Can't be forged.

A malicious user can't escalate their own power level, can't join rooms they weren't invited to, and can't forge key announcements. The only attack surface is the Matrix homeserver itself (if compromised, it could allow unauthorized events — but this is true of any federated system).

---

## 7. Migration Path

### From `_sharing` to Matrix Power Levels

The existing `_sharing` array on space state is **replaced** by Matrix power levels as the source of truth:

| Old system | New system |
|-----------|-----------|
| `_sharing` array with `{ user_id, access }` | Matrix room `m.room.power_levels` state event |
| Owner = `last_agent` of space INS | Owner = user with PL 100 |
| Sharing changes = DEF event on space | Role changes = `client.setPowerLevel()` |

### Migration Strategy

1. **For existing spaces with `_sharing`:** On first load under the new system, an admin runs a one-time migration:
   - Read `_sharing` from space state
   - Set Matrix power levels for each member based on mapping:
     - `'read'` → PL 0 (Viewer)
     - `'write'` → PL 25 (Editor)
     - `'admin'` → PL 50 (Admin)
   - Set room `m.room.power_levels` with the EO-DB event type config
   - The `_sharing` array remains in state as historical data but is no longer read by the app

2. **For new spaces:** Created with Matrix power levels from the start. No `_sharing` needed.

3. **Single-room to multi-room:** Optional upgrade. Existing single-room spaces continue to work — the restricted/governance rooms are opt-in. An admin can "upgrade" by creating the additional rooms and assigning fields to them.

---

## 8. Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `github-matrix-dev/app/src/permissions/types.ts` | `AccessRole`, `FieldAssignment`, `SpaceConfig`, `ResolvedPermissions`, `ROLE_POWER_LEVELS`, `powerLevelToRole()` |
| `github-matrix-dev/app/src/permissions/resolve.ts` | `resolvePermissions()` — reads Matrix power level + room membership + field assignments → capability flags |
| `github-matrix-dev/app/src/permissions/room-topology.ts` | Helpers to create/manage multi-room space topology (create restricted room, governance room, manage membership) |
| `github-matrix-dev/app/src/components/FieldPermissions.tsx` | Field-level permission management sub-panel — assign fields to rooms, set locked_to overrides |
| `github-matrix-dev/app/src/components/PermissionBadge.tsx` | Small role badge component for top bar (reads power level, shows label) |
| `github-matrix-dev/app/src/components/ViewOnlyBanner.tsx` | Persistent "View only" banner for Viewer role |
| `github-matrix-dev/app/src/components/RedactedCell.tsx` | Black redaction bar component — solid `#000` rectangle with "You don't have access" tooltip |

### Modified Files

| File | Changes |
|------|---------|
| `github-matrix-dev/app/src/components/SpaceMembers.tsx` | Read roles from Matrix power levels instead of `_sharing`; show 5-tier role picker that sets power levels; field permissions section; manage room membership for restricted room |
| `github-matrix-dev/app/src/components/Layout.tsx` | Import `PermissionBadge`, show role badge in top bar; import `ViewOnlyBanner`, show for PL 0; gate Builder/Settings tabs behind PL >= 50 |
| `github-matrix-dev/app/src/components/TableView.tsx` | Import `resolvePermissions` + `RedactedCell`; lock icons on locked columns; black bars for redacted fields; filter context menu actions by role |
| `github-matrix-dev/app/src/components/RecordView.tsx` | Respect field visibility — redact restricted fields; disable editing for locked fields |
| `github-matrix-dev/app/src/components/ComposeView.tsx` | Filter available event types by user's power level |
| `github-matrix-dev/app/src/matrix/sync-manager.ts` | Join multiple rooms per space; merge events from main + restricted rooms into unified fold |
| `github-matrix-dev/app/src/matrix/event-bridge.ts` | Add event types for schema (`com.eo-db.schema`), governance (`com.eo-db.governance`), key announce (`com.eo-db.key.announce`) |
| `github-matrix-dev/app/src/db/types.ts` | Re-export permission types |
| `github-matrix-dev/app/src/db/fold.ts` | Add Creator ownership check (the only fold-level permission check) |
| `github-matrix-dev/app/src/store/eo-store.ts` | Add `resolvedPermissions` computed state; add `spaceRooms` state tracking multi-room topology |

---

## 9. Implementation Order

### Phase 1: Foundation (types + power level reading)
1. Create `permissions/types.ts` — `AccessRole`, `ROLE_POWER_LEVELS`, `powerLevelToRole()`, `ResolvedPermissions`
2. Create `permissions/resolve.ts` — read power level from Matrix Room object, compute capabilities
3. Update `event-bridge.ts` — add `com.eo-db.schema`, `com.eo-db.governance`, `com.eo-db.key.announce` event types

### Phase 2: Single-Room Power Levels (works without multi-room yet)
4. Update `SpaceMembers.tsx` — read roles from Matrix power levels, 5-tier role picker that calls `client.setPowerLevel()`
5. Create `PermissionBadge.tsx` and add to `Layout.tsx` top bar
6. Create `ViewOnlyBanner.tsx`, show for PL 0
7. Gate Builder/Settings tabs behind PL >= 50

### Phase 3: UI Guards (enforce visually)
8. Update `TableView.tsx` — lock icons for locked fields, filter context menu by role
9. Update `ComposeView.tsx` — filter event types by power level
10. Update `RecordView.tsx` — disable editing for restricted roles

### Phase 4: Multi-Room Topology (real data isolation)
11. Create `permissions/room-topology.ts` — create restricted/governance rooms, manage membership
12. Update `sync-manager.ts` — join multiple rooms per space, merge events
13. Store space config as room state event in governance room
14. Create `RedactedCell.tsx` — black bars for fields in rooms user isn't a member of

### Phase 5: Field-Level Permissions
15. Create `FieldPermissions.tsx` — assign fields to rooms, set `locked_to` overrides
16. Integrate into `SpaceMembers.tsx` as collapsible section
17. Wire field assignments into `resolvePermissions` → `TableView` rendering

### Phase 6: Creator Ownership Check
18. Add `_created_by` to INS processing in `fold.ts`
19. Add ownership check for Creator-level DEF events in `fold.ts`

---

## 10. Verification Plan

1. **Permission resolution tests** — unit test `resolvePermissions()` for all 5 power level tiers, field assignments, room membership combinations
2. **Matrix enforcement tests:**
   - Create a room with EO-DB power level config
   - Attempt to send `com.eo-db.event` as Viewer (PL 0) → Matrix rejects
   - Attempt to send `com.eo-db.schema` as Editor (PL 25) → Matrix rejects
   - Attempt to invite as Editor (PL 25) → Matrix rejects
   - Send `com.eo-db.event` as Creator (PL 10) → Matrix accepts
3. **Multi-room isolation tests:**
   - Create main + restricted rooms. Add user to main only.
   - Verify restricted room events never arrive at user's sync-manager
   - Verify redacted fields show black bars in UI
   - Invite user to restricted room → verify fields appear (black bars disappear)
   - Kick user from restricted room → verify fields are purged from IndexedDB, black bars return
4. **Creator ownership tests:**
   - Creator adds a record → `_created_by` set to their Matrix ID
   - Creator edits own record → fold accepts
   - Creator edits someone else's record → fold rejects
5. **UI tests:**
   - For each role: verify correct buttons visible/hidden, correct fields editable/locked/redacted
   - Change a user's power level → verify UI updates immediately
   - Viewer sees "View only" banner
   - Role badge in top bar reflects current power level
6. **Backward compatibility** — existing single-room spaces continue to work with power-level-based roles
