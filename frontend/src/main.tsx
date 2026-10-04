import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/cormorant-garamond/600.css'
import '@fontsource/cormorant-garamond/700.css'
import '@fontsource/courier-prime/400.css'
import './index.css'
import { ApiError, onUnauthorized } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { qk } from '@/hooks/keys'
import { applyQuill, readQuillPref } from '@/lib/quill'
import { router } from './router'

applyQuill(readQuillPref())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // 4xx won't fix itself; only retry network blips and 5xx
      retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
})

// Session expired mid-use: forget the user and RequireAuth bounces to /login.
onUnauthorized(() => {
  if (queryClient.getQueryData(qk.me)) {
    queryClient.setQueryData(qk.me, null)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
