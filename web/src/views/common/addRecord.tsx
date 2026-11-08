/**
 * How the collection header's "New client" button reaches the open layout (COL-1, COL-8). Each layout adds a
 * record its own way (a card in a stack, a row in a group, a day on the calendar), so it registers that
 * here while it is shown and the header only runs it. A layout with no way to add (a form, a viewer's
 * view) registers nothing, and the button is disabled.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface AddRecordState {
  /** Whether the layout on screen can add a record now. */
  available: boolean;
  run(): void;
  register(add: (() => void) | null): void;
}

const AddRecordContext = createContext<AddRecordState | null>(null);

export function AddRecordProvider({ children }: { children: ReactNode }) {
  const add = useRef<(() => void) | null>(null);
  const [available, setAvailable] = useState(false);
  const register = useCallback((fn: (() => void) | null) => {
    add.current = fn;
    setAvailable(fn !== null);
  }, []);
  const run = useCallback(() => add.current?.(), []);
  const value = useMemo(() => ({ available, run, register }), [available, run, register]);
  return <AddRecordContext value={value}>{children}</AddRecordContext>;
}

/** The header's side: whether a record can be added, and how. Without a provider nothing can. */
export function useAddRecord(): Pick<AddRecordState, "available" | "run"> {
  const ctx = useContext(AddRecordContext);
  return ctx ?? { available: false, run: () => {} };
}

/** The layout's side: offers `onAdd` while the layout is on screen, and takes it back when it is not. */
export function useRegisterAddRecord(onAdd: (() => void) | undefined): void {
  const ctx = useContext(AddRecordContext);
  const latest = useRef(onAdd);
  latest.current = onAdd;
  const register = ctx?.register;
  const can = !!onAdd;
  useEffect(() => {
    if (!register || !can) return;
    register(() => latest.current?.());
    return () => register(null);
  }, [register, can]);
}
