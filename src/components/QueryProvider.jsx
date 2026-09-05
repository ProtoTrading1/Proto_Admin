import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { queryClient } from '../lib/queryClient';

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'proto_admin_query_cache',
});

export default function QueryProvider({ children }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60 * 1000,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => {
            if (query.state.status !== 'success') return false;
            const key = query.queryKey[0];
            // Featured drafts must remain session-only: persisting them could
            // expose one admin's abandoned draft to the next person signing in
            // on the same browser. The live list is tiny and refetches on mount.
            return key !== 'catalog' && key !== 'featured-products';
          },
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
