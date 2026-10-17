import { Link } from 'react-router'
import { Megaphone } from 'lucide-react'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { Skeleton } from '@/components/ui/skeleton'
import { useAdList } from '@/hooks/useAds'
import { STATUS_LABEL } from '@/lib/ads'
import { plural } from '@/lib/utils'
import { AdBriefForm } from './AdBriefForm'

export function AdStudioPage() {
  const list = useAdList()
  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="ads-h" className="relative h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-2">
          <h1 id="ads-h" className="font-display text-[22px] font-semibold">
            Ad Studio
          </h1>
          <p className="text-body text-studio-muted">Finished social ads for your brand: concepts in your language, a photo for each, your logo, colours and contact details laid out for every format.</p>
          <AdBriefForm />
        </div>
        <section aria-labelledby="ads-mine" className="flex flex-col gap-2">
          <h2 id="ads-mine" className="font-display text-title font-semibold">
            Your campaigns
          </h2>
          {list.isPending && <Skeleton className="h-24" />}
          {list.isError && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
          {list.data?.length === 0 && (
            <EmptyState icon={<Megaphone />} title="No campaigns yet">
              Your first one appears here as soon as it starts.
            </EmptyState>
          )}
          <ul className="flex flex-col gap-2">
            {list.data?.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/image/ads/${c.id}`}
                  className="flex items-center gap-3 rounded-[6px] border border-studio-border bg-studio-raised p-2 hover:border-studio-border-hover focus-visible:outline-2 focus-visible:outline-studio-accent"
                >
                  <span className="flex aspect-[4/5] w-11 shrink-0 overflow-hidden rounded-[3px] bg-studio-panel">
                    {c.thumb_url && <img src={c.thumb_url} alt="" className="size-full object-cover" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span dir="auto" lang={c.language} className="block truncate text-body font-medium">
                      {c.title || 'Untitled'}
                    </span>
                    <span className="block text-small text-studio-muted">
                      {STATUS_LABEL[c.status] ?? c.status} · {plural(c.concepts, 'concept')} · {plural(c.ads, 'ad')} · {c.formats.join(', ')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}
