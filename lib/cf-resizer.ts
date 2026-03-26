import { readFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"

interface CfResizeOpts {
  w?: number
  h?: number
  c?: number | string
  q?: number
  domain?: string
}

// Load config once, cache in module scope
let _domain: string | null = null

function loadDomain(): string {
  if (_domain) return _domain
  let dir = process.cwd()
  while (true) {
    const p = resolve(dir, ".cf-resizer.yaml")
    if (existsSync(p)) {
      const m = readFileSync(p, "utf8").match(/domain\s*:\s*(.+)/)
      if (m) { _domain = m[1].trim(); return _domain }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  _domain = process.env.CF_DOMAIN || "localhost"
  return _domain
}

export function cfResizeUrl(sha1: string, opts: CfResizeOpts = {}): string {
  const domain = opts.domain || loadDomain()
  const transforms: string[] = []

  if (opts.c) transforms.push(`c${opts.c}`)
  if (opts.w) transforms.push(`w${opts.w}`)
  if (opts.h) transforms.push(`h${opts.h}`)
  if (opts.q) transforms.push(`q${opts.q}`)

  const base = `https://${domain}`
  if (transforms.length === 0) return `${base}/${sha1}`
  return `${base}/r/${transforms.join("")}/${sha1}`
}
