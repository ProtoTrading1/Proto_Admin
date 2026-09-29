import { useCallback, useRef } from 'react';

export const PRODUCT_LOADER_LEAVE_MESSAGE = 'Leave Product Loader? Your unfinished landed batch is not saved. Loaded images, stock sheets, selections and category assignments will be cleared. Choose Cancel to keep working, or OK to leave.';

// A ref lets a child report draft state without rerendering the entire admin page.
// Only successful unmount/cleanup clears it; cancelling never changes the draft.
export function useProductLoaderLeaveGuard(setSection) {
  const pending = useRef(false);
  const onPendingWorkChange = useCallback((value) => { pending.current = Boolean(value); }, []);
  const confirmLeave = useCallback(() => !pending.current || window.confirm(PRODUCT_LOADER_LEAVE_MESSAGE), []);
  const requestSectionChange = useCallback((section) => {
    if (section !== 'product-loader' && !confirmLeave()) return false;
    setSection(section);
    return true;
  }, [confirmLeave, setSection]);
  return { onPendingWorkChange, confirmLeave, requestSectionChange };
}
