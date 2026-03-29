# Network Model: Emergent Commons Governance

**How the nine operators produce Ostrom-style collective self-governance without bolting on a separate permission system.**

---

## 0. Design Principle: No Schema Before Interaction

This is not a roles-and-permissions system. There is no admin panel where you define team structures before people can interact. Structure emerges from operator events — the same events that create data also create governance. A "team" is not a first-class entity the database knows about. It is a pattern: a SEG boundary with CON membership edges and EVA policies at the boundary. The database doesn't need to know it's a team. The operators produce team-like behavior as a natural consequence of their composition.

The alternative — defining roles, permissions, and team structures as a schema that precedes interaction — is a Level 2 trap. It imposes categories before the community has discovered what its categories are. The EO network model lets categories emerge from use and crystallize into governance only when the community chooses to formalize them.

---

## 1. Ostrom's Eight Principles as Operator Compositions

### 1.1 Clearly Defined Boundaries → SEG

SEG draws boundaries. A group exists when someone draws a SEG on a region of the target space.

```
SEG  target: "network.crew.infraTeam"
     operand: { boundary: "group", membership: "open" | "petition" | "invite" }
```

The boundary operand carries the boundary's own rules: can anyone join, or must they petition, or must they be invited? This is not a fixed enum — it's a DEF-able value that the group can change about itself.

The boundary is **mutable**. Another SEG can redraw it. The question of *who* can redraw it is answered by the EVA policies at or above that boundary — not by a hardcoded permission check.

### 1.2 Rules Matched to Local Conditions → EVA with Jurisdiction

EVA policies carry jurisdiction through their target path. A policy at `network.crew.infraTeam` governs that team. A policy at `network.crew` governs all crews. A policy at `network` governs the whole network. Horizon's governance layer already walks this ancestry chain.

```
EVA  target: "network.crew.infraTeam._governance.editPolicy"
     operand: {
       strategy: "custody",          — authority comes from proximity to the target
       scope: "network.crew.infraTeam",
       rule: { ... }
     }
```

The policy doesn't need to be "assigned" to a scope — its target path IS its scope. Move the policy to a different path, it governs a different region. This is jurisdiction by address, not by configuration.

### 1.3 Collective-Choice Arrangements → EVA Governing EVA

The people governed by rules participate in making them. This means EVA policies that take other EVA policies as input — governance of governance.

```
EVA  target: "network.crew.infraTeam._governance._meta"
     operand: {
       strategy: "collective",
       quorum: { type: "fraction", value: 0.5, of: "members" },
       scope: "network.crew.infraTeam._governance"
     }
```

This EVA policy governs the `_governance` subtree itself. Changing any governance rule requires a quorum of members. The policy is itself subject to governance — it lives under the scope it governs. REC resolves the circularity: when a governance change triggers re-evaluation of the meta-governance, the fold iterates until the state stabilizes or detects oscillation.

### 1.4 Monitoring → NUL + Log

NUL observes without changing. Every NUL event is logged. The append-only log IS the monitoring system. Horizon's signals layer (Layer 6) can detect statistical patterns across the log — resource depletion, activity concentration, participation imbalance — without requiring anyone to define what "health" means in advance.

Monitoring tracks effects (what happened in the log), not essence (what category something belongs to). The transformation hash on every state entry is a compressed history — you can tell whether two targets have had similar trajectories without reading their full logs.

### 1.5 Graduated Sanctions → EVA with Trajectory Awareness

EVA policies can reference the Horizon's trajectory layer. A policy that checks an agent's history of boundary violations produces graduated responses naturally:

```
EVA  target: "network._governance.sanctionPolicy"
     operand: {
       strategy: "graduated",
       input: "trajectory",          — evaluate based on the agent's operational history
       thresholds: [
         { count: 1, response: "notice" },
         { count: 3, response: "cooldown", duration: "7d" },
         { count: 5, response: "petition_required" }
       ]
     }
```

The graduated response emerges from the log — not from a punishment table. The log is the evidence. The trajectory is the pattern. The EVA policy maps pattern to response.

### 1.6 Conflict Resolution → REC on Contested State

When two agents submit contradictory DEF events to the same target, the fold currently uses last-writer-wins. EVA policies can override this with context-sensitive resolution:

```
EVA  target: "network.crew.infraTeam._governance.conflictPolicy"
     operand: {
       strategy: "resolution",
       methods: ["custody", "seniority", "collective"],
       escalation: "network._governance.conflictPolicy"
     }
```

Resolution methods are tried in order. If "custody" can resolve it (the person with closest relationship to the target wins), done. If not, "seniority" (longest membership). If not, "collective" (put it to the group). If the group can't resolve it, escalate to the parent scope's conflict policy.

This is internal, low-cost, and follows the nested structure. The community addresses its own contradictions without requiring an external authority.

### 1.7 Minimal Recognition by External Authorities → SEG as Insulation

SEG boundaries insulate. A SEG with `boundary: "sovereign"` means the region inside governs itself. External systems (platforms, institutions, other networks) can observe the boundary (NUL) and acknowledge it (SIG) without penetrating it.

The encryption scope pattern already demonstrates this: a SEG with `boundary: "encrypt"` makes everything below it opaque to anyone without the key. Sovereignty is the governance analog of encryption — it makes the internal governance opaque to external schema imposition.

### 1.8 Nested Enterprises → Target Path Hierarchy + Horizon Ancestry

This is already built. The target path `network.crew.infraTeam.member.alice` encodes a hierarchy. Horizon's ancestry walk gathers governance at each level. Each level can have its own EVA policies appropriate to its scale.

```
network                          → network-wide policies (meta-governance)
  network.crew                   → crew-level coordination norms
    network.crew.infraTeam       → team-specific rules
      network.crew.infraTeam.res → team resources (the commons)
```

Governance at `network.crew.infraTeam` doesn't need to know about governance at `network`. Horizon gathers both and presents them together. Conflicts between levels are resolved by the conflict policy at the nearest common ancestor.

---

## 2. The Custody Mechanic

This is the core innovation for the "provider stores info, person claims it" pattern — but the mechanic is general.

### 2.1 Authority From Proximity, Not Assignment

Traditional systems assign permissions: "User X has role Y on resource Z." This is Level 2 — the permission schema precedes interaction.

The custody mechanic computes authority from the CON graph at read time. Authority is not stored — it is derived from relationships. The relationships are stored (as CON edges). Authority falls out.

**Custody chain**: A CON edge with `edge_type: "custody"` means "this agent has custody of this target." Multiple agents can have custody. When they conflict, EVA policies at the governing scope resolve it.

**Proximity principle**: An agent who IS the target (via SYN) has higher authority than an agent who has custody of it, who has higher authority than an agent who merely created it, who has higher authority than an agent who can observe it. This isn't a hardcoded hierarchy — it's the default EVA policy. Communities can override it.

### 2.2 How Claiming Works

1. **Provider creates record**: Provider does INS + DEF on `network.people.rec_alice`. Agent is `@provider:homeserver`. Provider has custody via creation — the CON graph records this.

2. **Provider links person**: Provider does CON linking `network.people.rec_alice` to an external identifier (email, phone, etc).

3. **Person arrives**: Alice authenticates. Her agent is `@alice:homeserver`.

4. **Person claims**: Alice submits a SYN event merging her agent identity with the record. The SYN doesn't destroy the provider's history — it adds Alice's identity to the entity. The transformation hash carries both histories.

5. **Authority shifts**: After SYN, Alice IS the record (not just connected to it). The custody resolution function walks the graph and finds that Alice has a SYN relationship — closer than the provider's custody-by-creation. Alice now has higher authority.

6. **Provider retains provenance**: The provider's original events are still in the log. The provider can still read (NUL) the record. But DEF events from the provider on Alice's record now require Alice's EVA policy to permit them — because Alice's governance applies to her own record.

The provider doesn't "lose access." The authority gradient shifts. The person closest to the identity has the strongest voice. This is not a binary permission flip — it's a continuous gradient computed from the graph.

### 2.3 Custody Resolution Algorithm

```
Given: agent A wants to perform operator OP on target T

1. Resolve T through SYN aliases
2. Walk Horizon ancestry to gather all EVA governance policies
3. Find the most specific (deepest) governance policy for OP
4. Evaluate the policy:
   a. "custody" strategy → walk CON graph from T:
      - SYN relationship (agent IS target): authority = SELF
      - custody edge from agent to T:       authority = CUSTODIAN
      - agent created T (in log):           authority = CREATOR
      - agent has NUL/SIG on T:             authority = OBSERVER
   b. "collective" strategy → count member CON edges, check quorum
   c. "open" strategy → allow (anyone in the boundary can act)
5. Policy returns: allow | deny | escalate
6. If escalate: recurse with parent scope's policy
```

This is the same ancestry walk that encryption scope and Horizon governance already do. No new traversal mechanic needed.

---

## 3. Network Topology: Groups as Emergent Structure

### 3.1 A Group Is a SEG + CON + EVA Composition

There is no `Group` type. A group is what happens when these three operators compose:

```
INS  "network.crew.infraTeam"              — the group exists
SEG  "network.crew.infraTeam"              — { boundary: "group", membership: "petition" }
CON  "network.crew.infraTeam"              — { added: ["network.people.alice"], edge_type: "member" }
CON  "network.crew.infraTeam"              — { added: ["network.people.bob"], edge_type: "member" }
EVA  "network.crew.infraTeam._governance"  — { strategy: "collective", quorum: { type: "fraction", value: 0.5, of: "members" } }
```

After these five events, `infraTeam` is a group with two members and majority-rule governance. No group schema was defined. The group emerged from operator composition.

### 3.2 Nested Teams

```
INS  "network.crew"                        — the crew level exists
SEG  "network.crew"                        — { boundary: "group", membership: "open" }
INS  "network.crew.infraTeam"              — nested inside crew
INS  "network.crew.designTeam"             — nested inside crew
```

Horizon ancestry means `infraTeam` inherits `crew`-level governance. `infraTeam` can add its own EVA policies that are more specific. The most specific policy wins, with escalation to parent scope on conflict.

### 3.3 Roles as EVA Policies, Not Labels

A "role" is not a label attached to a person. It is an EVA policy that references a CON edge type.

```
CON  "network.crew.infraTeam"  — { added: ["network.people.alice"], edge_type: "steward" }
EVA  "network.crew.infraTeam._governance.stewardPolicy"
     operand: {
       strategy: "role",
       edge_type: "steward",
       capabilities: ["SEG", "EVA", "CON"],    — stewards can modify boundaries, governance, membership
       scope: "network.crew.infraTeam"
     }
```

Alice is a "steward" because there's a CON edge of type "steward" from the team to Alice, and an EVA policy that gives steward edges certain capabilities. Change the CON edge, the role changes. Change the EVA policy, the role's meaning changes. The community governs both.

### 3.4 Stigmergic Coordination

Not all coordination requires deliberate governance. The log and the CON graph enable stigmergy — indirect coordination through environmental traces.

When Alice DEFs a value, it appears in the log. Bob's Horizon read shows it in the trajectory. Bob responds to Alice's trace without explicit communication. The shared environment (the state projection) mediates.

No EVA policy governs this. No role authorizes it. It happens because the operators leave traces and Horizon makes traces visible. This is the coordination mode that Linux and Wikipedia run on — and it requires no governance machinery at all. The log IS the stigmergic medium.

---

## 4. The Protogon Phase: Pre-Governance Emergence

The hardest thing to build is NOT mature governance. It's the phase before governance, when a group is forming but hasn't yet decided what it is. Ostrom studied successful commons — she didn't study the phase that precedes them.

### 4.1 Open Boundaries, No Policies

A new group starts with:

```
INS  "network.crew.newThing"
SEG  "network.crew.newThing"  — { boundary: "group", membership: "open" }
```

No EVA policies. No roles. Anyone can join (CON), anyone can contribute (DEF), anyone can observe (NUL). The group IS its interactions. This is the protogon — identity actively forming but not yet crystallized.

### 4.2 Governance Crystallization

As the group develops, patterns emerge in the log. Someone starts acting as a steward (their trajectory shows it). The group can formalize this:

```
CON  "network.crew.newThing"  — { added: ["network.people.alice"], edge_type: "steward" }
EVA  "network.crew.newThing._governance.stewardPolicy"  — { ... }
```

Or it can stay informal. The operators don't require governance to function. Governance is an optional crystallization of patterns that already exist in practice.

### 4.3 Preventing Ossification

A mature commons can lose its responsiveness. The counter-mechanism: EVA policies have no special protection. They're targets like anything else. They can be DEF'd, EVA'd, even SYN'd. The meta-governance policy (§1.3) determines who can change governance — and the meta-governance policy is itself changeable.

REC at the governance level — taking the governance structure as input to restructuring — is the rarest operation. It requires the community to examine its own rules and change them. The fold supports it mechanically (REC can contain EVA events). Whether the community actually does it is a human question, not a technical one. The tool's job is to not prevent it.

---

## 5. The Commons Pattern

A commons is a shared resource governed by its users. In EO terms:

```
network.commons.sharedKnowledgeBase           — the commons (INS + SEG)
network.commons.sharedKnowledgeBase.res.*     — the shared resources (INS + DEF)
network.commons.sharedKnowledgeBase._members  — CON edges to participants
network.commons.sharedKnowledgeBase._governance — EVA policies
```

The resources live inside the SEG boundary. The members are CON-connected. The governance is EVA policies at the boundary. Horizon ancestry lets resources inherit the commons' governance. The log tracks all contributions. The transformation hash on each resource compresses its provenance.

**What makes it a commons and not just a shared folder:**

1. The governance policies are INSIDE the boundary they govern (not imposed from outside)
2. The members can change the governance (EVA policies are themselves governed by collective-choice meta-governance)
3. The boundary is self-defined (the community's SEG, not an admin's configuration)
4. Monitoring is structural (the log exists because operations exist, not because someone configured auditing)
5. Authority flows from relationship (custody mechanic), not from role assignment

---

## 6. Implementation Surface

What the fold already provides:
- Nine-case operator dispatch with helix ordering
- CON graph with typed edges and traversal
- EVA policy storage and Horizon governance walk
- SYN alias resolution and merge
- REC fixed-point iteration
- Horizon ancestry with governance layer
- Append-only log with transformation hashing

What this model adds:
- **Operand conventions** for network patterns (§6.1 in network-types.ts)
- **Custody resolution** function that walks CON/SYN graph to compute authority (§6.2 in custody.ts)
- Both are compositions of existing fold operations — no new storage substrate, no new operator semantics

The network model is not a layer on top of EO. It is a reading of what EO already does when you use the operators to describe how people relate to each other and to shared resources.
