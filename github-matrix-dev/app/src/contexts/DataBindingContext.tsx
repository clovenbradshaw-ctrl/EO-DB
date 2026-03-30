/**
 * DataBindingContext — Propagates the @ context item from parent sections
 * and record pages to child blocks.
 *
 * Two levels of context:
 * - pageRecord: set by record pages, available to ALL blocks on the page
 * - contextItem: set by sections or record pages, can be overridden by nested sections
 *
 * On a record page, contextItem defaults to pageRecord unless a section overrides it.
 */

import { createContext, useContext } from 'react';
import type { EoState } from '../db/types';
import type { PageType } from '../blocks/types';

interface DataBindingContextValue {
  /** The current @ context item (set by nearest parent section or page) */
  contextItem: EoState | null;
  /** The page-level record (set by record pages, never overridden by sections) */
  pageRecord: EoState | null;
  /** The current page type */
  pageType: PageType;
}

const DataBindingCtx = createContext<DataBindingContextValue>({
  contextItem: null,
  pageRecord: null,
  pageType: 'page',
});

export function DataBindingProvider({
  contextItem,
  pageRecord,
  pageType,
  children,
}: {
  contextItem: EoState | null;
  pageRecord?: EoState | null;
  pageType?: PageType;
  children: React.ReactNode;
}) {
  // Inherit pageRecord and pageType from parent context if not provided
  const parent = useContext(DataBindingCtx);
  const effectivePageRecord = pageRecord !== undefined ? pageRecord : parent.pageRecord;
  const effectivePageType = pageType !== undefined ? pageType : parent.pageType;

  return (
    <DataBindingCtx.Provider value={{
      contextItem: contextItem ?? effectivePageRecord,
      pageRecord: effectivePageRecord,
      pageType: effectivePageType,
    }}>
      {children}
    </DataBindingCtx.Provider>
  );
}

export function useDataBindingContext(): DataBindingContextValue {
  return useContext(DataBindingCtx);
}
