import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './lib/auth.tsx';
import App from './App.tsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live syncing without a socket: everything refetches on an interval and
      // whenever the tab regains focus, so a coordinator and a contractor
      // looking at the same permit converge within a minute.
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      retry: (count, err: any) => (err?.status === 401 || err?.status === 403 ? false : count < 2),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);

/*
 * Register the service worker.
 *
 * Only in production and only over HTTPS: a service worker in dev caches a
 * shell that fights the dev server's hot reload, and the resulting "why is my
 * change not showing" costs more time than offline support saves.
 *
 * Failure is swallowed on purpose. A supervisor whose browser refuses to
 * register a worker should still get a working web app, not a blank screen —
 * offline support is an improvement to this product, not a prerequisite for it.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
