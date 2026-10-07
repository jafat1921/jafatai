import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ImageSourceField } from '@/components/media/ImageSourceField'
import { SourceDropZone } from '@/components/media/SourceDropZone'
import { MAX_PRODUCTS, type BrandProduct } from '@/lib/brand'
import { EditorSection, type AssetUrls } from './EditorSection'

function ProductRow({
  p,
  index,
  url,
  onChange,
  onRemove,
}: {
  p: BrandProduct
  index: number
  url?: string | null
  onChange: (p: BrandProduct) => void
  onRemove: () => void
}) {
  const uid = useId()
  const name = p.name || `Product ${index + 1}`
  return (
    <li className="grid gap-3 rounded-[6px] border border-studio-border bg-studio-raised p-3 md:grid-cols-[auto_1fr]">
      <ImageSourceField
        label={`${name} picture`}
        required
        value={p.media_id}
        previewUrl={url}
        onChange={(id) => (id ? onChange({ ...p, media_id: id }) : onRemove())}
        purpose="product"
        aspectClass="aspect-square"
        removeLabel={`Remove ${name}`}
      />
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-n`} className="text-small font-medium">
            Name
          </label>
          <Input
            id={`${uid}-n`}
            dir="auto"
            maxLength={120}
            value={p.name}
            aria-invalid={!p.name.trim() || undefined}
            onChange={(e) => onChange({ ...p, name: e.target.value })}
            placeholder="e.g. Cold brew can"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-d`} className="text-small font-medium">
            Description
          </label>
          <Input
            id={`${uid}-d`}
            dir="auto"
            maxLength={300}
            value={p.description}
            onChange={(e) => onChange({ ...p, description: e.target.value })}
            placeholder="e.g. matte black 330 ml can, gold ring pull"
          />
        </div>
        <Button type="button" size="sm" variant="ghost" className="self-start" onClick={onRemove}>
          <Trash2 aria-hidden />
          Remove product
        </Button>
      </div>
    </li>
  )
}

export function ProductsSection({ products, urls, onChange }: { products: BrandProduct[]; urls: AssetUrls; onChange: (p: BrandProduct[]) => void }) {
  const full = products.length >= MAX_PRODUCTS
  return (
    <EditorSection
      title={`Products (${products.length}/${MAX_PRODUCTS})`}
      hint="Clear pictures of what you sell. The AI uses them as references, so the product stays recognisable in scenes."
    >
      {products.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Products">
          {products.map((p, i) => (
            <ProductRow
              key={`${p.media_id}-${i}`}
              p={p}
              index={i}
              url={urls[p.media_id]}
              onChange={(next) => onChange(products.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(products.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
      )}
      {full ? (
        <p className="text-small text-studio-muted">That's the most a kit can hold. Remove one to add another.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-1 text-small font-medium">
            <Plus aria-hidden className="size-3.5" />
            Add a product
          </span>
          <SourceDropZone
            label="Add a product"
            purpose="product"
            multiple
            pickMax={MAX_PRODUCTS - products.length}
            onAdd={(items) =>
              onChange([...products, ...items.map((m) => ({ media_id: m.id, name: m.title?.replace(/\.[a-z0-9]+$/i, '') ?? '', description: '' }))].slice(0, MAX_PRODUCTS))
            }
          />
        </div>
      )}
    </EditorSection>
  )
}
