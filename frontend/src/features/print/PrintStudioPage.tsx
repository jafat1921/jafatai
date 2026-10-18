import { Link } from 'react-router'
import { Printer } from 'lucide-react'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { Skeleton } from '@/components/ui/skeleton'
import { usePrintList } from '@/hooks/usePrint'
import { JOB_LABELS, STATUS_LABEL } from '@/lib/print'
import { plural } from '@/lib/utils'
import { PrintBriefForm } from './PrintBriefForm'

/** Print Studio (admins only): the brief on one side, the jobs so far on the other. */
export function PrintStudioPage() {
  const list = usePrintList()
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" role="region" aria-labelledby="print-h">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 id="print-h" className="font-display text-title font-semibold">
          Print Studio
        </h1>
        <p className="text-body text-studio-muted">
          Shop signs, boards, flyers and window stickers at their real size: a few strong options, print-ready PDF with bleed and crop marks, high-resolution PNG and JPG, and editable layers.
        </p>
        <PrintBriefForm />
      </div>
      <section aria-labelledby="print-mine" className="flex min-w-0 flex-col gap-2">
        <h2 id="print-mine" className="font-display text-title font-semibold">
          Print jobs
        </h2>
        {list.isPending && <Skeleton className="h-24" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
        {list.data?.length === 0 && (
          <EmptyState icon={<Printer />} title="No print jobs yet">
            Your first one appears here as soon as it starts.
          </EmptyState>
        )}
        <ul className="flex flex-col gap-2">
          {list.data?.map((j) => (
            <li key={j.id}>
              <Link
                to={`/admin/print/${j.id}`}
                className="flex min-w-0 items-center gap-3 rounded-[6px] border border-studio-border bg-studio-raised p-2 hover:border-studio-border-hover focus-visible:outline-2 focus-visible:outline-studio-accent"
              >
                <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-studio-panel">
                  {j.thumb_url ? (
                    <img src={j.thumb_url} alt="" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <Printer aria-hidden className="size-4 text-studio-muted" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span dir="auto" lang={j.language} className="block truncate text-body font-medium">
                    {j.title || 'Untitled'}
                  </span>
                  <span className="block truncate text-small text-studio-muted">
                    {STATUS_LABEL[j.status] ?? j.status} · {JOB_LABELS[j.job] ?? j.job} · {plural(j.designs, 'option')}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
