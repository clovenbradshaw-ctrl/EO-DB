/**
 * DataBindingContext — Propagates the @ context item from parent sections
 * to child blocks.
 *
 * A section block with a binding sets the @ context for all its children.
 * Children access it via useDataBindingContext().
 */

import { createContext, useContext } from 'react';
import type { EoState } from '../db/types';

interface DataBindingContextValue {
  /** The current @ context item (set by nearest parent section with a binding) */
  contextItem: EoState | null;
}

const DataBindingCtx = createContext<DataBindingContextValue>({
  contextItem: null,
});

export function DataBindingProvider({
  contextItem,
  children,
}: {
  contextItem: EoState | null;
  children: React.ReactNode;
}) {
  return (
    <DataBindingCtx.Provider value={{ contextItem }}>
      {children}
    </DataBindingCtx.Provider>
  );
}

export function useDataBindingContext(): DataBindingContextValue {
  return useContext(DataBindingCtx);
}
