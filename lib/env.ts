import { readFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"

// Package root (where src/index.ts lives)
export const root = resolve(dirname(new URL(import.meta.url).pathname), "..")

function findConfig(): string | null {
  // Walk up from cwd looking for .cf-resizer.yaml
  let dir = process.cwd()
  while (true) {
    const p = resolve(dir, ".cf-resizer.yaml")
    if (existsSync(p)) return p
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveEnv(val: string): string {
  return val.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] || "")
}

function parseYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^#:\s]+)\s*:\s*(.+?)\s*$/)
    if (m) result[m[1]] = resolveEnv(m[2].replace(/^["']|["']$/g, ""))
  }
  return result
}

const configPath = findConfig()
if (!configPath) {
  console.error(`Config not found. Create .cf-resizer.yaml:

domain: img.example.com
secret: your_admin_secret
bucket: bucket_name
max_size: 1600`)
  process.exit(1)
}

const config = parseYaml(readFileSync(configPath, "utf8"))

if (!config.domain || !config.secret || !config.bucket) {
  console.error(".cf-resizer.yaml must have: domain, secret, bucket")
  process.exit(1)
}

export const domain = config.domain
export const secret = config.secret
export const bucket = config.bucket
export const maxSize = parseInt(config.max_size || "1600", 10)
export const baseUrl = `https://${domain}`
