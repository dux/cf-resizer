# cf-resizer

Cloudflare image resize worker. Stores originals in R2, serves resized/converted images via CF Image Resizing, caches in R2 and CDN.

* Content-addressed storage (SHA1)
* Auto format negotiation (avif/webp/jpeg)
* Resize, crop, quality control via URL
* CDN edge cache + R2 transform cache
* Daily cleanup of old cached transforms
* Single yaml config

## Install

```
bunx cf-resizer install
```

Interactive setup - prompts for domain, secret, bucket, max_size. Creates `.cf-resizer.yaml`, DNS record, R2 bucket, deploys worker.

## Config

`.cf-resizer.yaml` in project root:

```yaml
domain: img.example.com
secret: my_secret
bucket: my-images
max_size: 1600
```

Values support `$ENV_VAR` expansion:

```yaml
secret: $CF_RESIZER_SECRET
```

Add to `.gitignore`:
```
.cf-resizer.yaml
```

## CLI

```
bunx cf-resizer <command>

install    Generate config, create DNS, deploy
upload     Auto-prepare + upload image
list       List images (default 20, pass number for more)
delete     Delete images by sha1
asset      Upload any file to /assets/
prepare    Local resize + convert to webp
test       Test env, DNS, local tools, integration
```

### Upload

```bash
bunx cf-resizer upload photo.jpg
# => https://img.example.com/a3f2b8c1d4e5f6...

bunx cf-resizer upload https://example.com/photo.png
```

Images are resized to max_size and converted to webp before upload.
SVG files are uploaded unchanged.

### List and delete

```bash
bunx cf-resizer list        # last 20
bunx cf-resizer list 100    # last 100
bunx cf-resizer delete a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9
```

## URLs

### Original (auto format negotiation)
```
https://img.example.com/{sha1}
```

### Resize
```
https://img.example.com/r/w300/{sha1}       # width 300
https://img.example.com/r/h200/{sha1}       # height 200
https://img.example.com/r/w300h200/{sha1}   # width 300, height 200
```

### Crop (cover)
```
https://img.example.com/r/c400/{sha1}       # 400x400 square crop
https://img.example.com/r/c200x150/{sha1}   # 200x150 crop
```

### Quality
```
https://img.example.com/r/w300q75/{sha1}    # width 300, quality 75
```

### Query params (alternative)
```
https://img.example.com/r/{sha1}?w=300&h=200&q=75
https://img.example.com/r/{sha1}?c=400
```

## Client libs

Both libs auto-load domain from `.cf-resizer.yaml` (searched up from cwd). Config is loaded once and cached in memory.

### TypeScript / JavaScript

```ts
import { cfResizeUrl } from "cf-resizer"

// Uses domain from .cf-resizer.yaml automatically
cfResizeUrl("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9")
// => "https://img.example.com/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

cfResizeUrl("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", { w: 300 })
// => "https://img.example.com/r/w300/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

cfResizeUrl("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", { c: "200x150" })
// => "https://img.example.com/r/c200x150/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

cfResizeUrl("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", { w: 300, q: 75 })
// => "https://img.example.com/r/w300q75/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

// Override domain
cfResizeUrl("a3f2...f8a9", { w: 300, domain: "cdn.other.com" })
```

### Ruby

```ruby
require "cf-resizer"  # or: require_relative "path/to/cf-resizer"

# Uses domain from .cf-resizer.yaml automatically
CfResizer.url("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9")
# => "https://img.example.com/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

CfResizer.url("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", w: 300)
# => "https://img.example.com/r/w300/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

CfResizer.url("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", c: "200x150")
# => "https://img.example.com/r/c200x150/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

CfResizer.url("a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", w: 300, q: 75)
# => "https://img.example.com/r/w300q75/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"

# Override domain
CfResizer.url("a3f2...f8a9", w: 300, domain: "cdn.other.com")

# Convenience method (also available)
cf_resize_url("a3f2...f8a9", w: 300)
```

### Assets

Upload any file (JS, CSS, fonts, etc.) to `/assets/`:

```bash
bunx cf-resizer asset app.js               # -> /assets/app.js
bunx cf-resizer asset build/app.min.js      # -> /assets/app.min.js
bunx cf-resizer asset app.js vendor/app.js  # -> /assets/vendor/app.js
```

Served with immutable cache headers at:
```
https://img.example.com/assets/app.js
https://img.example.com/assets/vendor/app.js
```

## API

Admin endpoints use secret in the URL path - no headers needed.

```
PUT    /upload/{secret}              Upload image (body = raw bytes)
GET    /list/{secret}?limit=20       List images
DELETE /delete/{secret}/{sha1}       Delete image
PUT    /assets/{secret}/{path}       Upload asset file
GET    /assets/{path}                Serve asset (public, cached)
```

### curl reference

```bash
# Upload image
curl -X PUT --data-binary @photo.webp \
  https://img.example.com/upload/SECRET

# Upload image from stdin
cat photo.jpg | curl -X PUT --data-binary @- \
  https://img.example.com/upload/SECRET

# List images (default 100, max 1000)
curl https://img.example.com/list/SECRET?limit=20

# Delete image
curl -X DELETE \
  https://img.example.com/delete/SECRET/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9

# Upload asset
curl -X PUT --data-binary @app.js \
  https://img.example.com/assets/SECRET/app.js

# Upload asset to subdirectory
curl -X PUT --data-binary @style.css \
  https://img.example.com/assets/SECRET/css/style.css

# Serve original image (auto format negotiation)
curl https://img.example.com/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9

# Serve resized
curl https://img.example.com/r/w300/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9

# Serve cropped
curl https://img.example.com/r/c200x150/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9

# Serve with quality
curl https://img.example.com/r/w300q75/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9

# Serve with query params
curl "https://img.example.com/r/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9?w=300&h=200&q=75"

# Serve asset
curl https://img.example.com/assets/app.js
curl https://img.example.com/assets/css/style.css

# Request webp explicitly
curl -H "Accept: image/webp" \
  https://img.example.com/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9

# Check cache status
curl -sI https://img.example.com/a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9 | grep X-Cache
```

## Test

```bash
bunx cf-resizer test           # all phases
bunx cf-resizer test env       # check tools + auth
bunx cf-resizer test dns       # check DNS
bunx cf-resizer test local     # test cf-prepare
bunx cf-resizer test integration  # upload, resize, delete
```

## Requirements

* [bun](https://bun.sh)
* [wrangler](https://developers.cloudflare.com/workers/wrangler/) (via npx)
* [flarectl](https://github.com/cloudflare/cloudflare-go/tree/master/cmd/flarectl) (for DNS)
* Cloudflare account with R2 and Image Resizing enabled
