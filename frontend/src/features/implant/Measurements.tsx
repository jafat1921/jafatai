import { useId, useState } from 'react'
import { ChevronDown, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usePatchPatient } from '@/hooks/useImplant'
import { MEASURES, type Measurements as M, type Patient } from '@/lib/implant'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body focus-visible:outline-2 focus-visible:outline-studio-accent'

const asText = (m: M) => Object.fromEntries(MEASURES.map(({ key }) => [key, m[key] == null ? '' : String(m[key])])) as Record<keyof M, string>

export function Measurements({ patient }: { patient: Patient }) {
  const uid = useId()
  const save = usePatchPatient(patient.id)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(() => asText(patient.measurements ?? {}))
  const filled = MEASURES.filter(({ key }) => form[key] !== '').length

  const body = (): M => {
    const out: Record<string, string | number | null> = {}
    for (const { key, text } of MEASURES) {
      const v = form[key].trim()
      out[key] = text ? v : v === '' ? null : Number(v)
    }
    return out as M
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="flex min-w-0 flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3">
      <h2 id={`${uid}-h`} className="font-display text-title font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-body`}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-[4px] text-left focus-visible:outline-2 focus-visible:outline-studio-accent"
        >
          Measurements
          <span className="text-small font-normal text-studio-muted">
            {filled} of {MEASURES.length} filled in
          </span>
          <ChevronDown aria-hidden className={cn('ml-auto size-4 transition-transform', open && 'rotate-180')} />
        </button>
      </h2>
      {open && (
        <form
          id={`${uid}-body`}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ measurements: body() }, { onSuccess: () => announce('Measurements saved') })
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {MEASURES.map(({ key, label, text }) => (
              <div key={key} className="flex flex-col gap-1">
                <label htmlFor={`${uid}-${key}`} className="text-small">
                  {label}
                </label>
                {key === 'ptosis_grade' ? (
                  <select id={`${uid}-${key}`} className={SELECT} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}>
                    <option value="">Not set</option>
                    {[0, 1, 2, 3].map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`${uid}-${key}`}
                    type={text ? 'text' : 'number'}
                    inputMode={text ? undefined : 'decimal'}
                    step={text ? undefined : 0.1}
                    maxLength={key === 'asymmetry' ? 300 : 20}
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
          {save.isError && (
            <p role="alert" className="text-small text-studio-danger">
              {save.error.message}
            </p>
          )}
          <Button type="submit" size="sm" variant="primary" className="self-start" loading={save.isPending}>
            <Save aria-hidden />
            Save
          </Button>
        </form>
      )}
    </section>
  )
}
