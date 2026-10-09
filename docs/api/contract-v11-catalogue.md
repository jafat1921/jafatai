# API contract v11: Photo catalogue (M10 phase 1)

This is a Lightroom-style catalogue for **image MediaItems**: uploads plus generated stills. Project frames stay in the general Library.

Database migration **0011** adds:
- marks and EXIF columns on `media_item`;
- three new tables: `client`, `album` and `album_item`.

## Import (`POST /api/media/upload`)
**Formats, in addition to PNG, JPEG and WebP:**
- camera RAW: NEF, NRW, CR2, CR3, ARW, RAF, ORF, RW2, DNG, PEF, SRW and others, up to **250 MB**;
- HEIC/HEIF, up to 250 MB;
- TIFF, up to 250 MB.

**How the original and the working copy are stored:**
- The original file is kept. You can download it from `GET /photos/{id}/source`.
- A full-resolution JPEG working copy (q97, 4:4:4, sRGB, key EXIF written back) becomes the current version, so browsers and Photo Studio can use it.
- RAW files are decoded with rawpy/LibRaw using the camera's white balance.
- HEIC files are decoded with pillow-heif. Display P3 colour is converted to sRGB.
- 16-bit greyscale TIFFs are scaled down to 8 bits.

**Optional multipart fields:**
- `album_id`: adds the photo to that album or shoot after storing it.
- `on_duplicate`: `skip` (the default) or `keep`.

**Duplicates:**
- A duplicate is detected by the SHA-256 of the file's bytes.
- When it is skipped, the response is **200** with the existing item and `duplicate: true`.

**EXIF stored in columns** (read with exifread, so it works for every format):
- `captured_at`: converted to UTC when the photo has an offset tag;
- `camera`, `lens`, `focal_mm`, `aperture`, `shutter_s`, `iso`, `gps_lat`, `gps_lng`;
- `exif`: every tag as text, at most 160 tags.

## New fields on MediaItemOut
| Field | Values |
|---|---|
| `rating` | 0–5 |
| `flag` | `pick` \| `reject` \| `""` |
| `label` | `red` \| `yellow` \| `green` \| `blue` \| `purple` \| `""` |
| `caption` | text |
| `captured_at`, `camera`, `lens`, `focal_mm`, `aperture`, `shutter_s`, `iso` | from EXIF |
| `original_name`, `bytes` | from the upload |
| `source_type` | `image/x-raw` \| `image/heic` \| `image/tiff` \| null |
| `edited` | true when the photo has more than one version |
| `album_ids` | albums the photo is in |
| `duplicate` | upload response only |

## Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/photos` | Filters and paging (see the next section). Returns `{items, total, offset, next_offset}` |
| GET | `/photos/facets` | Counts for each facet (see below) |
| GET | `/photos/{id}/neighbours` | Same filters as `/photos`. Returns `{ids, index, position, total, prev, next}`, used for Develop's previous/next |
| POST | `/photos/marks` | `{ids ≤2000, rating?, flag?: pick\|reject\|none, label?: …\|none}` |
| PATCH | `/photos/{id}` | `{title?, caption?, keywords?}` (keywords are the existing tags) |
| GET | `/photos/{id}/exif` | Summary plus all tags |
| GET | `/photos/{id}/source` | The original RAW, HEIC or TIFF file (404 when there isn't one) |
| GET/POST | `/albums` | GET returns the tree as a flat list: `{id, name, kind, parent_id, client_id, client_name, shoot_date, venue, notes, rules, cover_url, count, …}` |
| PATCH/DELETE | `/albums/{id}` | Deleting a folder moves its children up a level. Deleting an album never deletes photos |
| POST | `/albums/{id}/items` | `{ids, action: add\|remove}`. Only for `album` and `shoot` |
| POST | `/albums/{id}/order` | `{ids}` in the new order. Read it back with `sort=manual` |
| GET/POST/PATCH/DELETE | `/clients` | Deleting a client keeps its shoots and clears their client |

**`/photos` query parameters:**
- text and source: `q`, `origin`;
- marks: `rating_min`, `rating_max`, `flag` (comma list including `none`), `label` (comma list including `none`);
- metadata: `camera` and `lens` (lists separated by `|`), `keyword` (comma list; every keyword must match);
- dates: `date_from`, `date_to` (inclusive day), `added_from`;
- `edited`;
- where the photos live: `album_id`, `folder_id`, `client_id`, `favourite`;
- `sort`: taken \| added \| edited \| rating \| name \| size \| manual;
- `order`, `offset`, `limit` (at most 200).

"Taken" means `captured_at`, falling back to when the photo was added.

**`/photos/facets`:**
- Each facet ignores its own filter, so its counts show what choosing a different value would give.
- It returns: `flag`, `rating`, `label`, `camera`, `lens`, `keyword` (top 80), `date` (years and months), `edited` and `total`.

## Album kinds
- **`folder`**: holds albums and other folders. Nests at most 6 deep and refuses cycles.
- **`album`**: a manual collection, many-to-many with photos, ordered by position.
- **`shoot`**: an album with `client_id`, `shoot_date` and `venue`.
- **`smart`**: defined by `rules`:
  `{match: all|any, rules: [{field, op, value}]}` (1–20 rules).

| Smart-rule field | Operators |
|---|---|
| rating | = != >= <= |
| flag, label | = != |
| camera, lens | = contains |
| keyword | has lacks |
| text | contains |
| captured | in_last_days before after |
| origin, edited | = |
| album | in not_in (smart albums can refer to each other, at most 3 deep) |
| iso, focal, aperture | >= <= |

Filtering by a folder includes the photos of every album inside it.

## Admin
`python -m app.manage catalogue-backfill` fills in the hash, size and EXIF for older uploads. `install-server.sh` runs it after the migrations.
