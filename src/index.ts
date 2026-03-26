import { Hono, type Context } from "hono"

type Bindings = {
  BUCKET: R2Bucket
  ADMIN_SECRET?: string
  DOMAIN?: string
  MAX_SIZE?: string
}

const app = new Hono<{ Bindings: Bindings }>()
type Ctx = Context<{ Bindings: Bindings }>

const DEFAULT_MAX_SIZE = 1600
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB
const CACHE_HEADER = "public, max-age=31536000, immutable"

const MIME: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  gif: "image/gif",
  avif: "image/avif",
}

interface TransformOpts {
  width?: number
  height?: number
  fit?: "scale-down" | "cover"
  quality?: number
}

function parsePathTransforms(seg: string, maxSize = DEFAULT_MAX_SIZE): TransformOpts {
  const opts: TransformOpts = {}
  const re = /([whcq])(\d+(?:x\d+)?)/g
  let m: RegExpExecArray | null

  while ((m = re.exec(seg)) !== null) {
    const [, key, val] = m
    if (key === "w") {
      opts.width = clamp(parseInt(val, 10), maxSize)
      if (!opts.fit) opts.fit = "scale-down"
    } else if (key === "h") {
      opts.height = clamp(parseInt(val, 10), maxSize)
      if (!opts.fit) opts.fit = "scale-down"
    } else if (key === "c") {
      if (val.includes("x")) {
        const [w, h] = val.split("x").map(Number)
        opts.width = clamp(w, maxSize)
        opts.height = clamp(h, maxSize)
      } else {
        const s = clamp(parseInt(val, 10), maxSize)
        opts.width = s
        opts.height = s
      }
      opts.fit = "cover"
    } else if (key === "q") {
      opts.quality = Math.min(100, Math.max(1, parseInt(val, 10)))
    }
  }

  return opts
}

function parseQueryTransforms(url: URL, maxSize = DEFAULT_MAX_SIZE): TransformOpts {
  const opts: TransformOpts = {}
  const w = url.searchParams.get("w")
  const h = url.searchParams.get("h")
  const c = url.searchParams.get("c")
  const q = url.searchParams.get("q")

  if (w) { opts.width = clamp(parseInt(w, 10), maxSize); opts.fit = "scale-down" }
  if (h) { opts.height = clamp(parseInt(h, 10), maxSize); opts.fit = "scale-down" }
  if (c) {
    if (c.includes("x")) {
      const [cw, ch] = c.split("x").map(Number)
      opts.width = clamp(cw, maxSize)
      opts.height = clamp(ch, maxSize)
    } else {
      const s = clamp(parseInt(c, 10), maxSize)
      opts.width = s
      opts.height = s
    }
    opts.fit = "cover"
  }
  if (q) { opts.quality = Math.min(100, Math.max(1, parseInt(q, 10))) }

  return opts
}

function clamp(n: number, maxSize = DEFAULT_MAX_SIZE): number {
  return Math.min(maxSize, Math.max(1, n || 0))
}

function hasTransforms(opts: TransformOpts): boolean {
  return !!(opts.width || opts.height)
}

function detectFormat(obj: R2Object): string {
  const ct = obj.httpMetadata?.contentType || ""
  if (ct.includes("svg")) return "svg"
  if (ct.includes("avif")) return "avif"
  if (ct.includes("webp")) return "webp"
  if (ct.includes("png")) return "png"
  if (ct.includes("gif")) return "gif"
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpeg"
  if (ct.includes("bmp")) return "bmp"
  if (ct.includes("tiff")) return "tiff"
  return "jpeg"
}

function chooseOutputFormat(sourceFormat: string, accept: string): string {
  if (sourceFormat === "svg") return "svg"
  if (accept.includes("image/avif")) return "avif"
  if (accept.includes("image/webp")) return "webp"
  // Preserve PNG/GIF to keep transparency/animation
  if (sourceFormat === "png" || sourceFormat === "gif") return sourceFormat
  return "jpeg"
}

function r2Key(sha1: string): string {
  return `raw/${sha1}`
}

function isValidSha1(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s)
}

function getMaxSize(env: Bindings): number {
  return parseInt(env.MAX_SIZE || "", 10) || DEFAULT_MAX_SIZE
}

function serveRaw(obj: R2ObjectBody, format: string): Response {
  return new Response(obj.body, {
    headers: {
      "Content-Type": MIME[format] || "application/octet-stream",
      "Cache-Control": CACHE_HEADER,
      "Vary": "Accept",
    },
  })
}

// Internal origin endpoint for CF Image Resizing to fetch from
app.get("/origin/:sha1{[0-9a-f]{40}}", async (c) => {
  const sha1 = c.req.param("sha1")
  const obj = await c.env.BUCKET.get(r2Key(sha1))
  if (!obj) return c.text("Not found", 404)
  const format = detectFormat(obj)
  return serveRaw(obj, format)
})

// Serve original - no transforms
app.get("/:sha1{[0-9a-f]{40}}", async (c) => {
  const sha1 = c.req.param("sha1")
  const obj = await c.env.BUCKET.get(r2Key(sha1))
  if (!obj) return c.text("Not found", 404)

  const sourceFormat = detectFormat(obj)
  const accept = c.req.header("accept") || ""
  const outFormat = chooseOutputFormat(sourceFormat, accept)

  // No conversion needed or SVG
  if (sourceFormat === "svg" || outFormat === sourceFormat) {
    return serveRaw(obj, sourceFormat)
  }

  // Format conversion via CF Image Resizing
  const domain = c.env.DOMAIN || new URL(c.req.url).hostname
  const originUrl = `https://${domain}/origin/${sha1}`

  try {
    const transformed = await fetch(originUrl, {
      cf: { image: { format: outFormat, quality: 85 } },
    } as any)

    if (transformed.ok) {
      return new Response(transformed.body, {
        headers: {
          "Content-Type": MIME[outFormat] || "application/octet-stream",
          "Cache-Control": CACHE_HEADER,
          "Vary": "Accept",
        },
      })
    }
  } catch (e: any) {
    console.error("Format conversion error:", e.message || e)
  }

  // Fallback: serve original
  return serveRaw(obj, sourceFormat)
})

// Resize with path-based transforms: /r/<transforms>/<sha1>
app.get("/r/:transforms/:sha1{[0-9a-f]{40}}", async (c) => {
  const sha1 = c.req.param("sha1")
  const transformStr = c.req.param("transforms")

  if (!isValidSha1(sha1)) return c.text("Bad request", 400)

  const opts = parsePathTransforms(transformStr, getMaxSize(c.env))
  if (!hasTransforms(opts) && !opts.quality) {
    return c.redirect(`/${sha1}`, 302)
  }

  return transform(c, sha1, opts)
})

// Resize with query-based transforms: /r/<sha1>?w=200&h=150
app.get("/r/:sha1{[0-9a-f]{40}}", async (c) => {
  const sha1 = c.req.param("sha1")
  const url = new URL(c.req.url)
  const opts = parseQueryTransforms(url, getMaxSize(c.env))

  if (!hasTransforms(opts) && !opts.quality) {
    return c.redirect(`/${sha1}`, 302)
  }

  return transform(c, sha1, opts)
})

function cacheKey(sha1: string, opts: TransformOpts, format: string): string {
  const parts = [`cache/${sha1}`]
  if (opts.width) parts.push(`w${opts.width}`)
  if (opts.height) parts.push(`h${opts.height}`)
  if (opts.fit === "cover") parts.push("cover")
  if (opts.quality) parts.push(`q${opts.quality}`)
  parts.push(format)
  return parts.join("_")
}

async function transform(c: Ctx, sha1: string, opts: TransformOpts) {
  const obj = await c.env.BUCKET.get(r2Key(sha1))
  if (!obj) return c.text("Not found", 404)

  const sourceFormat = detectFormat(obj)

  // SVG: ignore transforms, serve as-is
  if (sourceFormat === "svg") {
    return serveRaw(obj, "svg")
  }

  const accept = c.req.header("accept") || ""
  const outFormat = chooseOutputFormat(sourceFormat, accept)
  const key = cacheKey(sha1, opts, outFormat)

  // Check R2 cache
  const cached = await c.env.BUCKET.get(key)
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": MIME[outFormat] || "application/octet-stream",
        "Cache-Control": CACHE_HEADER,
        "Vary": "Accept",
      },
    })
  }

  // Build CF Image Resizing options
  const imageOpts: Record<string, any> = {
    format: outFormat,
    quality: opts.quality || 85,
  }
  if (opts.width) imageOpts.width = opts.width
  if (opts.height) imageOpts.height = opts.height
  if (opts.fit) imageOpts.fit = opts.fit

  try {
    const domain = c.env.DOMAIN || new URL(c.req.url).hostname
    const originUrl = `https://${domain}/origin/${sha1}`

    const transformed = await fetch(originUrl, {
      cf: { image: imageOpts },
    } as any)

    if (transformed.ok) {
      const body = await transformed.arrayBuffer()

      // Store in R2 cache
      c.executionCtx.waitUntil(
        c.env.BUCKET.put(key, body, {
          httpMetadata: { contentType: MIME[outFormat] || "application/octet-stream" },
        })
      )

      return new Response(body, {
        headers: {
          "Content-Type": MIME[outFormat] || "application/octet-stream",
          "Cache-Control": CACHE_HEADER,
          "Vary": "Accept",
        },
      })
    }

    return new Response(`Transform failed: ${transformed.status}`, { status: 500 })
  } catch (e: any) {
    console.error("Transform error, serving original:", e.message || e)
    // Fallback: re-read from R2 and serve original
    const fallback = await c.env.BUCKET.get(r2Key(sha1))
    if (!fallback) return c.text("Not found", 404)
    return serveRaw(fallback, sourceFormat)
  }
}

function checkAuth(c: Ctx): boolean {
  const secret = c.env.ADMIN_SECRET
  if (!secret) return false
  const input = c.req.param("secret") || ""
  if (input.length !== secret.length) return false
  // Constant-time comparison to prevent timing attacks
  const enc = new TextEncoder()
  const a = enc.encode(input)
  const b = enc.encode(secret)
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function detectMimeFromBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp"
  // TIFF: little-endian (II) or big-endian (MM)
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00) return "image/tiff"
  if (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A) return "image/tiff"
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === "avif" || brand === "avis") return "image/avif"
  }
  const text = new TextDecoder().decode(bytes.slice(0, 256))
  if (text.trimStart().startsWith("<svg") || text.trimStart().startsWith("<?xml")) return "image/svg+xml"
  return "application/octet-stream"
}

// Upload image
app.put("/upload/:secret", async (c) => {
  if (!checkAuth(c)) return c.text("Unauthorized", 401)

  const len = parseInt(c.req.header("content-length") || "0", 10)
  if (len > MAX_UPLOAD_BYTES) return c.text(`File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`, 413)

  const body = await c.req.arrayBuffer()
  if (!body || body.byteLength === 0) return c.text("Empty body", 400)
  if (body.byteLength > MAX_UPLOAD_BYTES) return c.text(`File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`, 413)

  const hash = await crypto.subtle.digest("SHA-1", body)
  const sha1 = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("")
  const key = r2Key(sha1)

  const ct = detectMimeFromBytes(body)
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: ct } })

  const domain = c.env.DOMAIN || new URL(c.req.url).hostname
  return c.json({ sha1, url: `https://${domain}/${sha1}` })
})

// List images
app.get("/list/:secret", async (c) => {
  if (!checkAuth(c)) return c.text("Unauthorized", 401)

  const cursor = c.req.query("cursor")
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 1000)
  const listed = await c.env.BUCKET.list({ prefix: "raw/", limit, cursor: cursor || undefined })

  const items = listed.objects.map((obj: any) => ({
    sha1: obj.key.replace("raw/", ""),
    size: obj.size,
  }))

  return c.json({
    items,
    cursor: listed.truncated ? listed.cursor : null,
  })
})

// Delete image
app.delete("/delete/:secret/:sha1{[0-9a-f]{40}}", async (c) => {
  if (!checkAuth(c)) return c.text("Unauthorized", 401)

  const sha1 = c.req.param("sha1")
  await c.env.BUCKET.delete(r2Key(sha1))
  return c.json({ deleted: sha1 })
})

// Upload asset
app.put("/assets/:secret/:path{.+}", async (c) => {
  if (!checkAuth(c)) return c.text("Unauthorized", 401)

  const path = c.req.param("path")
  const body = await c.req.arrayBuffer()
  if (!body || body.byteLength === 0) return c.text("Empty body", 400)

  const key = `assets/${path}`
  const ct = c.req.header("content-type") || mimeFromExt(path)
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: ct } })

  const domain = c.env.DOMAIN || new URL(c.req.url).hostname
  return c.json({ url: `https://${domain}/assets/${path}`, size: body.byteLength })
})

// Serve asset
app.get("/assets/:path{.+}", async (c) => {
  const path = c.req.param("path")
  const obj = await c.env.BUCKET.get(`assets/${path}`)
  if (!obj) return c.text("Not found", 404)

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || mimeFromExt(path),
      "Cache-Control": CACHE_HEADER,
    },
  })
})

function mimeFromExt(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || ""
  const map: Record<string, string> = {
    js: "application/javascript",
    mjs: "application/javascript",
    css: "text/css",
    html: "text/html",
    json: "application/json",
    txt: "text/plain",
    xml: "application/xml",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    pdf: "application/pdf",
    zip: "application/zip",
    ...MIME,
  }
  return map[ext] || "application/octet-stream"
}

// Test page - grid of 100 resized variants for cache testing
app.get("/test/:sha1{[0-9a-f]{40}}", async (c) => {
  const sha1 = c.req.param("sha1")
  const obj = await c.env.BUCKET.head(r2Key(sha1))
  if (!obj) return c.text("Not found - upload an image first", 404)

  const domain = c.env.DOMAIN || new URL(c.req.url).hostname
  const base = `https://${domain}`

  // Deterministic 100 test cases mixing all transform types
  // Sizes range 200-350px, seeded from index so every reload is identical
  const tests: { label: string; path: string; w: number; h: number }[] = []

  for (let i = 0; i < 100; i++) {
    const size = 200 + Math.round(i * 150 / 99) // 200..350
    const variant = i % 5

    let label: string
    let path: string
    let w: number
    let h: number

    if (variant === 0) {
      // width only
      const q = 60 + (i % 4) * 10 // 60,70,80,90
      label = `w${size} q${q}`
      path = `/r/w${size}q${q}/${sha1}`
      w = size
      h = Math.round(size * 0.75)
    } else if (variant === 1) {
      // height only
      label = `h${size}`
      path = `/r/h${size}/${sha1}`
      w = Math.round(size * 1.33)
      h = size
    } else if (variant === 2) {
      // square crop
      label = `c${size}`
      path = `/r/c${size}/${sha1}`
      w = size
      h = size
    } else if (variant === 3) {
      // rectangular crop
      const h2 = Math.round(size * 0.6)
      label = `c${size}x${h2}`
      path = `/r/c${size}x${h2}/${sha1}`
      w = size
      h = h2
    } else {
      // width + height
      const h2 = 200 + Math.round(((i * 7) % 100) * 150 / 99)
      label = `w${size}h${h2}`
      path = `/r/w${size}h${h2}/${sha1}`
      w = size
      h = h2
    }

    tests.push({ label, path, w, h })
  }

  const cards = tests.map((t, i) =>
    `<div class="card">
      <div class="img-wrap" style="width:${t.w}px;height:${t.h}px">
        <img src="${base}${t.path}" width="${t.w}" height="${t.h}" loading="lazy" alt="#${i}">
      </div>
      <div class="info">#${i} <code>${t.label}</code></div>
    </div>`
  ).join("\n")

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cf-resizer test - ${sha1.slice(0, 12)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:24px}
h1{font-size:18px;font-weight:500;color:#f48120;margin-bottom:4px}
.sub{font-size:13px;color:#888;margin-bottom:24px;font-family:ui-monospace,monospace}
.grid{display:flex;flex-wrap:wrap;gap:12px;align-items:start}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:8px;display:inline-flex;flex-direction:column;align-items:center;gap:6px;transition:border-color .15s}
.card:hover{border-color:#f48120}
.img-wrap{background:#111;border-radius:4px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.img-wrap img{display:block;object-fit:contain}
.info{font-size:11px;color:#999;font-family:ui-monospace,monospace;text-align:center;white-space:nowrap}
.info code{color:#ccc}
.stats{position:fixed;top:12px;right:16px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;font-size:12px;font-family:ui-monospace,monospace;color:#888;z-index:10}
.stats b{color:#f48120}
</style>
</head>
<body>
<div class="stats">loaded <b id="cnt">0</b>/100</div>
<h1>cf-resizer cache test</h1>
<p class="sub">${sha1} - 100 images, reload to test cache hits</p>
<div class="grid">
${cards}
</div>
<script>
let n=0;document.querySelectorAll("img").forEach(img=>{
  const done=()=>{n++;document.getElementById("cnt").textContent=n};
  if(img.complete)done();else{img.onload=done;img.onerror=done}
})
</script>
</body>
</html>`

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
  })
})

// Favicon
app.get("/favicon.ico", (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#f48120"/></svg>`
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=2592000",
    },
  })
})

// Root
app.get("/", (c) => c.text("cf-resizer github.com/dux/cf-resizer"))

// Debug
app.get("/debug", (c) => c.json({ cache: "enabled", ts: Date.now() }))

// Cron: delete cache entries older than 30 days
async function cleanCache(env: Bindings) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  let cursor: string | undefined
  let deleted = 0

  do {
    const listed = await env.BUCKET.list({ prefix: "cache/", limit: 100, cursor })
    const old = listed.objects.filter((obj: any) => new Date(obj.uploaded) < thirtyDaysAgo)

    if (old.length > 0) {
      await Promise.all(old.map((obj: any) => env.BUCKET.delete(obj.key)))
      deleted += old.length
    }

    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  console.log(`Cache cleanup: deleted ${deleted} entries`)
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    // Use CF CDN cache for GET requests on image routes
    if (request.method === "GET") {
      const url = new URL(request.url)
      const path = url.pathname
      // Cache image serves and transforms, skip admin/root endpoints
      const skip = path === "/" || path === "/debug" || path.startsWith("/test/") || path.startsWith("/list/") || path.startsWith("/upload/") || path.startsWith("/delete/")
      if (!skip) {
        try {
          const cache = caches.default
          // Include Accept header in cache key for format negotiation
          const accept = request.headers.get("accept") || ""
          const fmt = accept.includes("image/avif") ? "avif" : accept.includes("image/webp") ? "webp" : "default"
          const cacheUrl = new URL(request.url)
          cacheUrl.searchParams.set("_fmt", fmt)
          const cacheKey = new Request(cacheUrl.toString(), { method: "GET" })
          const cached = await cache.match(cacheKey)
          if (cached) {
            const headers = new Headers(cached.headers)
            headers.set("X-Cache", "HIT")
            return new Response(cached.body, { status: 200, headers })
          }

          const response = await app.fetch(request, env, ctx)
          if (response.ok) {
            const body = await response.arrayBuffer()
            const headers = new Headers(response.headers)
            headers.set("Content-Length", String(body.byteLength))
            headers.set("X-Cache", "MISS")
            const resp = new Response(body, { status: 200, headers })
            ctx.waitUntil(cache.put(cacheKey, resp.clone()))
            return resp
          }
          return response
        } catch (e: any) {
          return new Response(`Cache error: ${e.message}`, { status: 500 })
        }
      }
    }

    return app.fetch(request, env, ctx)
  },
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(cleanCache(env))
  },
}
