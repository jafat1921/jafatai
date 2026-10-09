# API contract v12: Develop workflow (M10 phase 2 / D1)

Database migration **0012** adds the `photo_snapshot` table. Everything else is additive on the v9 photo API.

## Panel switches: `params.off`
- `off: ["basic", "curve", "hsl", "detail", "effects", "local", "look"]` names the panels whose eye is switched off.
- Their settings are **kept**, but every render ignores them: preview, histogram, save/export, `.cube` bake and video grade.
- `geometry` (crop and rotate) can't be switched off; it is dropped from the list.
- `GET /photo/schema` now includes `switchable: string[]`.

## Snapshots
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/photo/{id}/snapshots` | — | Newest first: `[{id, name, base_id, params (sparse), created_at, updated_at}]` for the picture's whole version line |
| POST | `/photo/{id}/snapshots` | `{name, params, base_id?}` (base must be a version of the same picture) | 201 snapshot |
| PATCH | `/photo/snapshots/{sid}` | `{name?, params?}` | snapshot |
| DELETE | `/photo/snapshots/{sid}` | — | 204 |

## Sync settings
`POST /photo/sync` with `{ids ≤500 (library item or generation ids), params, groups, format?, quality?}` returns 202:

```
{queued, results: [{id, job_id | null, error | null, unchanged?}]}
```

How each picture is synced:
1. **Find its edit state.** If the current version is a develop, its base and params are used. Otherwise the current version itself is the base, with empty params.
2. **Merge.** The ticked `groups` (with their on/off state) are taken from `params`; every other group keeps the picture's own settings.
3. **Render.** A new version is queued from that base, so nothing is overwritten. Pictures that would not change get `unchanged: true` and no job.

`groups` accepts: basic, curve, hsl, detail, effects, local, geometry, look.

## Client-side (no API)
- **Settings clipboard:** Copy/Paste by group, and Previous (the settings of the last photo edited). Both live in `localStorage`.
- **History:** the in-session undo timeline, which you can click to jump to any step.
- **Live preview:**
  - clipping overlay (J);
  - RGB readout under the pointer;
  - an unedited "before" frame (with crop and straighten applied) for the split and side-by-side views.
