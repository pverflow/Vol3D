import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const checkOnly = process.argv.includes('--check')

const packageJsonPath = path.join(repoRoot, 'package.json')
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml')
const cargoLockPath = path.join(repoRoot, 'src-tauri', 'Cargo.lock')
const tauriConfigPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json')

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
const version = packageJson.version

if (typeof version !== 'string' || !version.trim()) {
  throw new Error('package.json version is missing or invalid')
}

const changes = []

await syncTextFile(cargoTomlPath, (text) => replaceCargoTomlVersion(text, version), 'src-tauri/Cargo.toml')
await syncTextFile(cargoLockPath, (text) => replaceCargoLockVersion(text, version), 'src-tauri/Cargo.lock')
await syncJsonFile(tauriConfigPath, (json) => ({ ...json, version }), 'src-tauri/tauri.conf.json')

if (checkOnly) {
  if (changes.length > 0) {
    throw new Error(`Version drift detected for ${changes.join(', ')}. Run npm run version:sync.`)
  }
  console.log(`[version] OK ${version}`)
} else if (changes.length > 0) {
  console.log(`[version] Synced ${version} -> ${changes.join(', ')}`)
} else {
  console.log(`[version] Already synced at ${version}`)
}

async function syncTextFile(filePath, updater, label) {
  const original = await readFile(filePath, 'utf8')
  const next = updater(original)
  if (next === original) return
  changes.push(label)
  if (!checkOnly) {
    await writeFile(filePath, next, 'utf8')
  }
}

async function syncJsonFile(filePath, updater, label) {
  const original = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(original)
  const nextObject = updater(parsed)
  const next = `${JSON.stringify(nextObject, null, 2)}\n`
  if (next === original) return
  changes.push(label)
  if (!checkOnly) {
    await writeFile(filePath, next, 'utf8')
  }
}

function replaceCargoTomlVersion(text, nextVersion) {
  const pattern = /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/
  if (!pattern.test(text)) {
    throw new Error('Failed to update version in src-tauri/Cargo.toml')
  }

  return text.replace(pattern, `$1${nextVersion}$3`)
}

function replaceCargoLockVersion(text, nextVersion) {
  const pattern = /(\[\[package\]\]\r?\nname = "vol3d"\r?\nversion = ")([^"]+)(")/
  if (!pattern.test(text)) {
    throw new Error('Failed to update version in src-tauri/Cargo.lock')
  }

  return text.replace(pattern, `$1${nextVersion}$3`)
}


