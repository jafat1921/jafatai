// Browser-side conversions of the loaded GLB. Loaded on first use, like the viewer.
import type { Object3D } from 'three'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js'

export type ExportFormat = 'obj' | 'stl' | 'usdz'

export const MIME: Record<ExportFormat, string> = {
  obj: 'model/obj',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
}

export async function exportModel(model: Object3D, format: ExportFormat): Promise<Blob> {
  // the viewer spins the model itself; bake that in so the file matches what's on screen
  model.updateMatrixWorld(true)
  if (format === 'obj') return new Blob([new OBJExporter().parse(model)], { type: MIME.obj })
  if (format === 'stl') return new Blob([new STLExporter().parse(model, { binary: true }).buffer], { type: MIME.stl })
  // USDZ keeps the PBR textures, so it opens with colour on an iPhone (AR Quick Look)
  const bytes = await new USDZExporter().parseAsync(model)
  return new Blob([bytes], { type: MIME.usdz })
}
