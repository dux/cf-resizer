# CF Image Resizer - Plan

## Context

All TypeScript/JS, runs via `bun`. Components:
1. **`bin/cf-resizer`** - main CLI entry point, dispatches subcommands
2. **`bin/cf-prepare`** - resize + convert to webp locally
3. **`bin/cf-upload`** - upload to R2
4. **`bin/cf-test`** - full test suite
5. **Resize worker** - Hono on CF Workers, serves + transforms images on demand

`bin/cf-resizer` is the main interface:
```sh
cf-resizer prepare photo.jpg -o out.webp   # resize + convert to webp
cf-resizer upload photo.jpg                 # auto-prepare + upload to R2
cf-resizer list                             # list objects in R2 bucket
cf-resizer delete photo.webp                # delete object from R2
cf-resizer deploy                           # deploy worker via wrangler
cf-resizer test                             # run full test suite
cf-resizer help                             # show all commands
cf-resizer                                  # show help
```

Each subcommand also works standalone via `bin/cf-prepare`, `bin/cf-upload`, etc.

Images live in R2, worker serves them with content negotiation (webp if browser
supports it, original format otherwise) and max cache headers. CF CDN caches at edge.

### R2 Storage Layout

Objects split by first 2 chars of key to avoid flat bucket with millions of objects:

```
<bucket>/
  ph/photo.webp
  im/images/hero.webp
  aH/aHR0cHM6Ly9leGFtcGxlLmNvbS9waWMuanBn    # cached URL
```

R2 key is always a hash, split by first 2 chars:

Key = sha1 of image data. `cf-upload photo.jpg` -> sha1 of prepared webp -> `a3/a3f2b8c1d4...`

Same image uploaded 10x = same sha1 = same URL every time.


## Env Vars

```
CF_ACCOUNT_ID    - Cloudflare account ID
CF_R2_KEY_ID     - R2 API token access key ID
CF_R2_KEY_SECRET - R2 API token secret access key
CF_BUCKET        - R2 bucket name
CF_DOMAIN        - Domain for the image worker (e.g. img.example.com)
CF_MAX_SIZE      - Max dimension in px (default: 1600). Caps both width and height.
```

R2 uses S3-compatible API at `https://<account_id>.r2.cloudflarestorage.com`.
You create R2 API tokens in CF dashboard > R2 > Manage R2 API Tokens.

## Part 1: `bin/cf-prepare` - Resize + Convert

TypeScript script using **sharp** via `bun`.
Sharp has prebuilt native binaries for linux/mac/win - no compilation needed.

### Usage

```sh
# Show image stats (dry run, no output file)
bin/cf-prepare photo.jpg
# => 4032x3024 jpeg 2.1MB -> 1600x1200 webp

# Output to file
bin/cf-prepare photo.jpg -o ready.webp

# From URL
bin/cf-prepare https://example.com/photo.jpg -o ready.webp

# Combined pipeline: prepare then upload
bin/cf-prepare photo.jpg -o tmp/photo.webp && bin/cf-upload upload tmp/photo.webp
```

### Behavior

- Accepts local path or URL as input
- Resizes so largest dimension (w or h) <= CF_MAX_SIZE (default 1600px)
  - Only downscales, never upscales
  - Preserves aspect ratio
- Converts to webp at quality 90
- With `-o path`: writes webp to that path
- Without `-o`: dry run - prints image stats (dimensions, format, file size, would-resize info)
- If image is already <= CF_MAX_SIZE, only converts format (no resize)

## Part 2: `bin/cf-upload` - Auto-prepare + Upload to R2

TypeScript script via `bun`. Uses `@aws-sdk/client-s3` for S3-compatible R2 upload.
Always auto-prepares (resize + webp) before uploading.

### Usage

```sh
# Upload local file (auto-prepares: resize + webp)
bin/cf-upload photo.jpg

# Upload from URL
bin/cf-upload https://example.com/photo.jpg

# Upload with custom key
bin/cf-upload photo.jpg --key images/hero.webp
```

### Behavior

- Detects URL vs local path (starts with http:// or https://)
- For URLs: fetches to tmp first
- Always runs cf-prepare internally (resize to CF_MAX_SIZE + convert to webp)
- SVG files uploaded as-is (no conversion)
- Key defaults to filename with .webp ext (e.g. `photo.jpg` -> `photo.webp`), overridable with `--key`
- Prints the full URL on success: `https://CF_DOMAIN/photo.webp`

## Part 2.5: `bin/cf-list` and `bin/cf-delete` - R2 Management

### Usage

```sh
bin/cf-list                  # list all objects in bucket
bin/cf-list images/          # list objects with prefix
bin/cf-delete photo.webp     # delete single object
bin/cf-delete images/*.webp  # delete multiple (glob on keys)
```

## cf-prepare Testing

Use small local test assets in `test/fixtures/`. Create them via sharp or ImageMagick once.

**Test fixtures** (generate in a setup script `test/create-fixtures.sh`):
```
test/fixtures/
  photo.jpg       # 3200x2400 jpeg
  photo.png       # 3200x2400 png
  photo.webp      # 3200x2400 webp
  photo.gif       # 200x200 animated gif
  photo.avif      # 3200x2400 avif
  photo.bmp       # 3200x2400 bmp
  photo.tiff      # 3200x2400 tiff
  icon.svg        # simple svg file
  small.jpg       # 800x600 (already under CF_MAX_SIZE)
```

**Test cases:**

| Input | Expected behavior |
|-------|-------------------|
| `cf-prepare photo.jpg` | Stats: `3200x2400 jpeg 1.2MB -> 1600x1200 webp` |
| `cf-prepare photo.jpg -o tmp/out.webp` | Writes 1600x1200 webp |
| `cf-prepare photo.png -o tmp/out.webp` | Writes 1600x1200 webp (png -> webp) |
| `cf-prepare photo.webp -o tmp/out.webp` | Writes 1600x1200 webp (downscaled) |
| `cf-prepare photo.gif -o tmp/out.webp` | Writes webp (animated gif handling) |
| `cf-prepare photo.avif -o tmp/out.webp` | Writes 1600x1200 webp (avif -> webp) |
| `cf-prepare photo.bmp -o tmp/out.webp` | Writes 1600x1200 webp (bmp -> webp) |
| `cf-prepare photo.tiff -o tmp/out.webp` | Writes 1600x1200 webp (tiff -> webp) |
| `cf-prepare icon.svg` | Stats: svg unchanged (passthrough) |
| `cf-prepare icon.svg -o tmp/out.svg` | Copies svg as-is, no conversion |
| `cf-prepare small.jpg -o tmp/out.webp` | Writes 800x600 webp (no resize, only format convert) |
| `cf-prepare small.jpg` | Stats: `800x600 jpeg 95KB -> 800x600 webp` (no resize needed) |

**Verify output:**
- All non-svg outputs are valid webp
- Dimensions <= CF_MAX_SIZE on longest side
- Aspect ratio preserved
- SVG files pass through unchanged

## Part 3: Client Libraries

Helper libs that generate resize URLs. Accept an R2 key or original URL,
return the full `img.example.com` URL with transforms.

### `lib/cf-resizer.rb`

```ruby
# cf_resize_url("a3f2b8c1d4...f8a9", w: 300)
# => "https://img.example.com/r/w300/a3f2b8c1d4...f8a9"
#
# cf_resize_url("a3f2b8c1d4...f8a9")
# => "https://img.example.com/a3f2b8c1d4...f8a9"
```

### `lib/cf-resizer.ts`

```ts
cfResizeUrl("a3f2b8c1d4...f8a9", { w: 300 })
// => "https://img.example.com/r/w300/a3f2b8c1d4...f8a9"

cfResizeUrl("a3f2b8c1d4...f8a9")
// => "https://img.example.com/a3f2b8c1d4...f8a9"
```

### Behavior

- Takes sha1 (from cf-upload) + optional transform opts
- Builds transform segment from opts: `w`, `h`, `c`, `q`
- Prepends `/r/<transforms>/` if any opts, otherwise just `/<sha1>`
- Domain from `CF_DOMAIN` env var or explicit param
- No dependencies, single file each

## Part 4: Resize Worker

Worker uses **Images binding** (`env.IMAGES`) + R2 binding. No `cf.image` on fetch.
Images binding reads blobs directly from R2 - no self-fetch, no public URL needed.

### URL Format

Path-based only, no query params. `<sha1>` is the sha1 of the image data
(40 hex chars). Same image = same sha1 = same URL always.

Both path-based and query-based transforms supported:

```
https://img.example.com/<sha1>
https://img.example.com/r/<transforms>/<sha1>
https://img.example.com/r/<sha1>?<transforms>
```

### Examples

```
# cf-upload prints: https://img.example.com/a3f2b8...f8a9
/a3f2b8...f8a9                # original
/r/w200/a3f2b8...f8a9         # path-based: scale to 200
/r/a3f2b8...f8a9?w=200        # query-based: same result
/r/c400/a3f2b8...f8a9         # path: cover crop 400x400
/r/a3f2b8...f8a9?c=400        # query: same
/r/c200x300/a3f2b8...f8a9     # path: cover crop 200x300
/r/a3f2b8...f8a9?c=200x300    # query: same
/r/w200q75/a3f2b8...f8a9      # path: combined
/r/a3f2b8...f8a9?w=200&q=75   # query: combined
```

### Transform Syntax

Transforms live in a single path segment after `/r/`. Parsed left-to-right:

| Token | Images API options | Description |
|-------|-------------------|-------------|
| `w<N>` | `width + fit:scale-down` | Scale to width, preserve aspect ratio |
| `h<N>` | `height + fit:scale-down` | Scale to height, preserve aspect ratio |
| `c<N>` | `width:N, height:N, fit:cover` | Square crop NxN, like CSS `object-fit: cover` |
| `c<N>x<N>` | `width:W, height:H, fit:cover` | Crop WxH, like CSS `object-fit: cover` |
| `q<N>` | `quality` | Quality 1-100 (default 85) |

**Crop behavior (`c`)**: works like CSS `object-fit: cover` - scales the image
to fill the target box, then crops overflow from center. The image always fills
the exact dimensions, no letterboxing.

All dimensions clamped to CF_MAX_SIZE (default 1600).
No `/r/` prefix = serve original (still auto-format based on browser support).

### Format Conversion

No `?f=` param. Format is automatic based on browser `Accept` header
and source format. Internal conversion map:

**If browser supports webp** (`Accept: image/webp`):
| Source | Output | Why |
|--------|--------|-----|
| jpeg | webp | smaller, same quality |
| png | webp | smaller, supports transparency |
| gif | png | sharp output, preserves frames as still |
| bmp | webp | modernize |
| tiff | webp | modernize |
| webp | webp | no conversion needed |
| svg | svg | passthrough, unchanged |

**If browser does NOT support webp** (old browsers):
| Source | Output | Why |
|--------|--------|-----|
| jpeg | jpeg | keep as-is |
| png | png | keep as-is |
| gif | png | sharp output |
| bmp | png | lossless fallback |
| tiff | jpeg | lossy is fine for photos |
| webp | png | safe fallback with transparency |
| svg | svg | passthrough, unchanged |

SVG is always served as-is. No resizing, no conversion.

### Cache Headers

Worker sets aggressive cache on every response:
```
Cache-Control: public, max-age=31536000, immutable
```
CF CDN caches at edge. Browser caches locally. Images are immutable
(change the key/filename to bust cache).

### How it Works

1. Request: `img.example.com/r/w300/<sha1>`
2. Lookup: `env.BUCKET.get("<2char>/<sha1>")`
3. If miss -> `404`
5. If SVG, return as-is with cache headers
6. Determines output format from `Accept` header + conversion map
7. Calls `env.IMAGES.transform(blob, { width: 300, fit: "scale-down", format })`
8. Return transformed image with max cache headers

All images must be uploaded via `cf-upload` first. Worker only serves what's in R2.

### Error Handling

- Key not found in R2 -> `404 Not Found`
- Invalid transform tokens (non-numeric w/h/c, negative values) -> `400 Bad Request`
- SVG with resize params -> ignore params, serve SVG as-is
- Images transform failure -> `500` with error message

### wrangler.toml Bindings

```toml
name = "cf-image-resizer"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "my-images"

[images]
binding = "IMAGES"
```

### File Structure

```
cf-image-resizer/
  bin/
    cf-resizer            # Main CLI - dispatches subcommands
    cf-prepare            # Resize + convert to webp
    cf-upload             # Auto-prepare + upload to R2
    cf-list               # List R2 objects
    cf-delete             # Delete R2 objects
    cf-test               # Full test suite
  src/
    index.ts              # Hono app, route handler
  lib/
    cf-resizer.rb           # Ruby client lib
    cf-resizer.ts           # TS client lib
  doc/
    plan.md
  test/
    fixtures/             # Test images
    create-fixtures.sh
  wrangler.toml
  tsconfig.json
  package.json            # sharp + @aws-sdk/client-s3 + hono + wrangler
```

## Part 3: Test Suite - `bin/cf-test`

Shell script that runs all tests. Uses `flarectl`, `wrangler`, and `curl`.

### Usage

```sh
bin/cf-test              # run all tests
bin/cf-test dns          # only DNS checks
bin/cf-test local        # only local/unit tests
bin/cf-test integration  # only live integration tests
```

### Test phases

**Phase 1: Environment checks**
- CF_ACCOUNT_ID, CF_R2_KEY_ID, CF_R2_KEY_SECRET, CF_BUCKET, CF_DOMAIN set
- `flarectl` available
- `wrangler` available
- `bun` available
**Phase 2: DNS checks** (`bin/cf-test dns`)
- `flarectl dns list --zone <zone>` - verify CF_DOMAIN has DNS record
- Verify CF_DOMAIN resolves (dig/nslookup)
- Verify CF_DOMAIN points to Cloudflare (proxied)

**Phase 3: Local tests** (`bin/cf-test local`)
- Generate test fixtures if missing (`test/create-fixtures.sh`)
- Run all cf-prepare test cases (from the test matrix above)
  - Each format converts to webp
  - SVG passthrough
  - Small images not upscaled
  - Verify output dimensions, format, file size
- Verify cf-upload can parse args (dry-run mode)

**Phase 4: Integration tests** (`bin/cf-test integration`)
- Upload test fixture to R2 via `bin/cf-upload`
- Verify original: `curl https://CF_DOMAIN/<b64key>` returns 200
- Test resize: `curl .../r/w300/<b64key>` - verify response is image
- Test crop: `curl .../r/c200/<b64key>` - verify 200
- Test WxH crop: `curl .../r/400x300/<b64key>` - verify 200
- Test quality: `curl .../r/w300q50/<b64key>` - verify smaller size
- Test content negotiation: `curl -H "Accept: image/webp" .../r/w300/<b64key>` - verify webp
- Test cache headers: verify `Cache-Control: public, max-age=31536000, immutable`
- Test 404: `curl .../<invalid_b64key>` returns 404
- Test bad transforms: `curl .../r/wABC/<b64key>` returns 400
- Cleanup: delete test object from R2

### Output

Green/red pass/fail per test, summary at end. Exit code 0 if all pass, 1 if any fail.

## Implementation Steps

1. **Scaffold Hono project** - `npm create hono@latest` with cloudflare-workers template
2. **Write `bin/cf-prepare`** - TS CLI, resize + webp convert via sharp
3. **Write `bin/cf-upload`** - TS CLI, auto-prepare + upload to R2
4. **Write `bin/cf-list`** + **`bin/cf-delete`** - R2 management
5. **Write `bin/cf-resizer`** - main CLI, dispatches all subcommands
6. **Write `src/index.ts`** - Hono app: serve/resize handler
7. **Configure `wrangler.toml`** - R2 + Images bindings, cron trigger
7. **Write `test/create-fixtures.sh`** - generate test images via sharp
8. **Write `bin/cf-test`** - full test suite (dns + local + integration)

## Prerequisites

- Cloudflare account with a zone (domain)
- R2 bucket
- R2 API token (S3-compatible credentials for CLI uploads)
- CF_DOMAIN DNS record pointing to the worker (via wrangler or flarectl)
- Images binding enabled (just add `[images]` to wrangler.toml)

### CF Limits

- Max input: 70 MB, 100 megapixels
- Animated GIF/WebP: 50 megapixels total
- `flarectl` installed (CF DNS management)
- `wrangler` installed (CF Workers CLI)
- `bun` installed (runs all CLI tools)
