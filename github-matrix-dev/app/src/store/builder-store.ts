import { create } from 'zustand';
import type { BlockNode, BlockId, BlockType, ViewDefinition, PageType, RecordSource } from '../blocks/types';
import { createBlock } from '../blocks/registry';
import { slugify } from '../lib/router';

// ---------------------------------------------------------------------------
// Tree helpers — immutable operations on the block tree
// ---------------------------------------------------------------------------

type BlockTree = BlockNode[];

/** Deep-find a block by ID, returns [block, parent array, index] */
function findBlock(
  tree: BlockTree,
  id: BlockId,
): [BlockNode, BlockTree, number] | null {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return [tree[i], tree, i];

    // Search children
    if (tree[i].children) {
      const found = findBlock(tree[i].children!, id);
      if (found) return found;
    }

    // Search slots
    if (tree[i].slots) {
      for (const slotKey of Object.keys(tree[i].slots!)) {
        const found = findBlock(tree[i].slots![slotKey], id);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Deep-clone tree, replacing a specific node's parent array */
function deepCloneTree(tree: BlockTree): BlockTree {
  return tree.map((node) => ({
    ...node,
    props: { ...node.props },
    children: node.children ? deepCloneTree(node.children) : undefined,
    slots: node.slots
      ? Object.fromEntries(
          Object.entries(node.slots).map(([k, v]) => [k, deepCloneTree(v)]),
        )
      : undefined,
  }));
}

/** Remove a block by ID from the tree, returns new tree */
function removeFromTree(tree: BlockTree, id: BlockId): BlockTree {
  const result: BlockTree = [];
  for (const node of tree) {
    if (node.id === id) continue;
    const cloned = { ...node, props: { ...node.props } };
    if (cloned.children) {
      cloned.children = removeFromTree(cloned.children, id);
    }
    if (cloned.slots) {
      cloned.slots = Object.fromEntries(
        Object.entries(cloned.slots).map(([k, v]) => [k, removeFromTree(v, id)]),
      );
    }
    result.push(cloned);
  }
  return result;
}

/** Insert a block into a target array at a given index */
function insertIntoTree(
  tree: BlockTree,
  block: BlockNode,
  parentId: BlockId | null,
  slotKey: string | null,
  index: number,
): BlockTree {
  // Insert at top level
  if (!parentId) {
    const newTree = [...tree];
    newTree.splice(index, 0, block);
    return newTree;
  }

  return tree.map((node) => {
    const cloned = { ...node, props: { ...node.props } };

    if (node.id === parentId) {
      if (slotKey && cloned.slots) {
        cloned.slots = { ...cloned.slots };
        const slot = [...(cloned.slots[slotKey] || [])];
        slot.splice(index, 0, block);
        cloned.slots[slotKey] = slot;
      } else if (cloned.children) {
        cloned.children = [...cloned.children];
        cloned.children.splice(index, 0, block);
      }
      return cloned;
    }

    if (cloned.children) {
      cloned.children = insertIntoTree(cloned.children, block, parentId, slotKey, index);
    }
    if (cloned.slots) {
      cloned.slots = Object.fromEntries(
        Object.entries(cloned.slots).map(([k, v]) => [
          k,
          insertIntoTree(v, block, parentId, slotKey, index),
        ]),
      );
    }
    return cloned;
  });
}

/** Update props on a specific block */
function updatePropsInTree(
  tree: BlockTree,
  id: BlockId,
  props: Record<string, any>,
): BlockTree {
  return tree.map((node) => {
    if (node.id === id) {
      return { ...node, props: { ...node.props, ...props } };
    }
    const cloned = { ...node };
    if (cloned.children) {
      cloned.children = updatePropsInTree(cloned.children, id, props);
    }
    if (cloned.slots) {
      cloned.slots = Object.fromEntries(
        Object.entries(cloned.slots).map(([k, v]) => [k, updatePropsInTree(v, id, props)]),
      );
    }
    return cloned;
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type BuilderMode = 'build' | 'live';

interface BuilderState {
  viewId: string | null;
  viewName: string;
  viewSlug: string;
  blocks: BlockNode[];
  selectedBlockId: BlockId | null;
  mode: BuilderMode;
  isDirty: boolean;

  /** Page type: 'page' (static), 'list' (collection), 'record' (profile) */
  pageType: PageType;
  /** For list/record pages: which collection this page is bound to */
  recordSource?: RecordSource;
  /** For record page preview: a sample record target to render with */
  previewRecordTarget?: string;
  /** Persona visibility — which user type IDs can see this view. Empty/absent = all. */
  visibleToTypes?: string[];

  // Actions
  newView: (name: string, pageType?: PageType) => string;
  loadView: (viewId: string, definition: ViewDefinition) => void;
  setMode: (mode: BuilderMode) => void;
  selectBlock: (id: BlockId | null) => void;
  setPageType: (pageType: PageType) => void;
  setRecordSource: (source: RecordSource | undefined) => void;
  setPreviewRecordTarget: (target: string | undefined) => void;
  setVisibleToTypes: (typeIds: string[] | undefined) => void;

  addBlock: (type: BlockType, parentId?: BlockId | null, slotKey?: string | null, index?: number) => BlockId;
  moveBlock: (blockId: BlockId, newParentId: BlockId | null, newSlotKey: string | null, newIndex: number) => void;
  removeBlock: (id: BlockId) => void;
  updateBlockProps: (id: BlockId, props: Record<string, any>) => void;

  getViewDefinition: () => ViewDefinition;
  markClean: () => void;
  reset: () => void;
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  viewId: null,
  viewName: 'Untitled View',
  viewSlug: '',
  blocks: [],
  selectedBlockId: null,
  mode: 'build',
  isDirty: false,
  pageType: 'page' as PageType,
  recordSource: undefined,
  previewRecordTarget: undefined,
  visibleToTypes: undefined,

  newView(name: string, pageType: PageType = 'page') {
    const viewId = crypto.randomUUID();
    set({
      viewId,
      viewName: name,
      viewSlug: slugify(name),
      blocks: [],
      selectedBlockId: null,
      mode: 'build',
      isDirty: true,
      pageType,
      recordSource: undefined,
      previewRecordTarget: undefined,
      visibleToTypes: undefined,
    });
    return viewId;
  },

  loadView(viewId: string, definition: ViewDefinition) {
    set({
      viewId,
      viewName: definition.name,
      viewSlug: definition.slug || slugify(definition.name),
      blocks: deepCloneTree(definition.blocks),
      selectedBlockId: null,
      mode: 'build',
      isDirty: false,
      pageType: definition.pageType || 'page',
      recordSource: definition.recordSource,
      previewRecordTarget: undefined,
      visibleToTypes: definition.visibleToTypes,
    });
  },

  setMode(mode: BuilderMode) {
    set({ mode, selectedBlockId: mode === 'live' ? null : get().selectedBlockId });
  },

  selectBlock(id: BlockId | null) {
    set({ selectedBlockId: id });
  },

  setPageType(pageType: PageType) {
    set({ pageType, isDirty: true });
  },

  setRecordSource(source: RecordSource | undefined) {
    set({ recordSource: source, isDirty: true });
  },

  setPreviewRecordTarget(target: string | undefined) {
    set({ previewRecordTarget: target });
  },

  setVisibleToTypes(typeIds: string[] | undefined) {
    const next = typeIds && typeIds.length > 0 ? typeIds : undefined;
    set({ visibleToTypes: next, isDirty: true });
  },

  addBlock(type: BlockType, parentId = null, slotKey = null, index?: number) {
    const block = createBlock(type);
    const { blocks } = get();
    const idx = index ?? (parentId ? 0 : blocks.length);
    const newBlocks = insertIntoTree(blocks, block, parentId, slotKey, idx);
    set({ blocks: newBlocks, isDirty: true, selectedBlockId: block.id });
    return block.id;
  },

  moveBlock(blockId: BlockId, newParentId: BlockId | null, newSlotKey: string | null, newIndex: number) {
    const { blocks } = get();
    const found = findBlock(blocks, blockId);
    if (!found) return;
    const [block] = found;
    // Remove then insert
    const removed = removeFromTree(blocks, blockId);
    const inserted = insertIntoTree(removed, block, newParentId, newSlotKey, newIndex);
    set({ blocks: inserted, isDirty: true });
  },

  removeBlock(id: BlockId) {
    const { blocks, selectedBlockId } = get();
    const newBlocks = removeFromTree(blocks, id);
    set({
      blocks: newBlocks,
      isDirty: true,
      selectedBlockId: selectedBlockId === id ? null : selectedBlockId,
    });
  },

  updateBlockProps(id: BlockId, props: Record<string, any>) {
    const { blocks } = get();
    set({ blocks: updatePropsInTree(blocks, id, props), isDirty: true });
  },

  getViewDefinition(): ViewDefinition {
    const { viewName, viewSlug, blocks, pageType, recordSource, visibleToTypes } = get();
    const def: ViewDefinition = {
      name: viewName,
      slug: viewSlug || slugify(viewName),
      blocks,
      pageType,
      recordSource,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (visibleToTypes && visibleToTypes.length > 0) {
      def.visibleToTypes = visibleToTypes;
    }
    return def;
  },

  markClean() {
    set({ isDirty: false });
  },

  reset() {
    set({
      viewId: null,
      viewName: 'Untitled View',
      viewSlug: '',
      blocks: [],
      selectedBlockId: null,
      mode: 'build',
      isDirty: false,
      pageType: 'page' as PageType,
      recordSource: undefined,
      previewRecordTarget: undefined,
      visibleToTypes: undefined,
    });
  },
}));
