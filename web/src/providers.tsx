import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { syncBaseTablesIntoWorkspaces } from "@/api/syncBaseTables";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeProvider } from "@/theme/ThemeProvider";

export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // Client errors will not fix themselves; transient ones get a couple of retries.
        retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
  syncBaseTablesIntoWorkspaces(client);
  return client;
}

export function Providers({ children, client }: { children: ReactNode; client: QueryClient }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
