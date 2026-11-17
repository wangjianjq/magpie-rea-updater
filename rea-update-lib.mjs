// Shared by rea-mcp-launch.mjs (DeepSeek Harness launcher) and the Magpie plugin magpie-rea-updater.
// Keeps the global npm package rea-agents up to date. Never writes to stdout.
//  - one shared lock (rea-update.lock) so only one updater installs at a time
//  - never installs while a rea process is running (its native modules would be locked -> EBUSY/half install)
//  - state shared in rea-update-state.json
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const BIN = path.dirname(fileURLToPath(import.meta.url))
export const LOCK = path.join(BIN, "rea-update.lock")
export const STATE = path.join(BIN, "rea-update-state.json")
const PF_NODE = "C:\\Program Files\\nodejs\\node.exe"
export const NODE = fs.existsSync(PF_NODE) ? PF_NODE : process.execPath
export const NPM = path.join(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js")
export const PKG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "rea-agents")
export const REA = path.join(PKG_DIR, "scripts", "rea.mjs")
export const STALE_MS = 10 * 60_000
const NOOP = () => {}

export function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")) || {} } catch { return {} } }
export function writeState(patch) {
  try {
    const next = { ...readState(), ...patch }
    const tmp = `${STATE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, STATE)
    return next
  } catch { return readState() }
}
export function installedVersion() { try { return JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8")).version || "" } catch { return "" } }
export const reaPresent = () => fs.existsSync(REA)
export function newer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}
function killTree(pid) { try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", NOOP) } catch {} }
export function run(cmd, args, { timeout = 30_000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", timedOut = false, p
    try { p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) }
    catch (e) { return resolve({ code: -1, out: "", err: String(e.message || e) }) }
    const t = setTimeout(() => { timedOut = true; killTree(p.pid) }, timeout)
    p.stdout.on("data", (d) => (out += d.toString("utf8")))
    p.stderr.on("data", (d) => (err += d.toString("utf8")))
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e.message || e) }) })
    p.on("close", (code) => { clearTimeout(t); resolve({ code: timedOut ? -2 : code, out, err: err + (timedOut ? "\n[timeout]" : "") }) })
  })
}
const npm = (args, timeout) => run(NODE, [NPM, ...args], { timeout })
const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)

// ---- shared lock ----------------------------------------------------------------------------
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }
export function acquireLock(who) {
  const body = JSON.stringify({ pid: process.pid, who, ts: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK, "wx")
      try { fs.writeSync(fd, body) } finally { fs.closeSync(fd) }
      return { ok: true, body }
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, reason: String(e.message || e) }
      let info = {}, age
      try { info = JSON.parse(fs.readFileSync(LOCK, "utf8")) } catch {}
      try { age = Date.now() - fs.statSync(LOCK).mtimeMs } catch { continue } // vanished meanwhile: retry
      const dead = info.pid && !alive(info.pid)
      if (age < STALE_MS && !dead) return { ok: false, reason: `held by ${info.who || "?"} (pid ${info.pid || "?"})` }
      // stale: move it away atomically (only one contender wins the rename), then retry the exclusive create
      const gone = `${LOCK}.stale-${process.pid}-${Date.now()}`
      try { fs.renameSync(LOCK, gone); fs.unlinkSync(gone) } catch {}
    }
  }
  return { ok: false, reason: "lock contention" }
}
export function releaseLock(h) {
  try { if (h && h.ok && fs.readFileSync(LOCK, "utf8") === h.body) fs.unlinkSync(LOCK) } catch {}
}

// ---- running rea processes (read-only query) ---------------------------------------------------
// The query runs as -EncodedCommand so that its own command line does not contain the patterns it looks for.
const PS = String.raw`$ErrorActionPreference='Stop'
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh)' -and $_.CommandLine -match 'rea-agents[\\/]scripts[\\/]rea\.mjs|rea-mcp-launch\.mjs' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.Name }`
export async function runningRea() {
  const enc = Buffer.from(PS, "utf16le").toString("base64")
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { timeout: 20_000 })
  if (r.code !== 0) return { ok: false, procs: [], err: lastLine(r.err || r.out) }
  const procs = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [pid, name] = l.split("|"); return { pid: Number(pid), name } }).filter((p) => p.pid && p.pid !== process.pid)
  return { ok: true, procs }
}

// ---- install ------------------------------------------------------------------------------------
async function install(ver, log) {
  const r = await npm(["install", "-g", `rea-agents@${ver}`, "--no-fund", "--no-audit"], 180_000)
  if (r.code !== 0) log(`npm install exit=${r.code}: ${lastLine(r.err)}`)
  if (!reaPresent()) {
    log("rea.mjs missing after install, repair reinstall")
    const r2 = await npm(["install", "-g", `rea-agents@${ver}`, "--no-fund", "--no-audit"], 180_000)
    if (r2.code !== 0) log(`repair install exit=${r2.code}: ${lastLine(r2.err)}`)
  }
  const got = installedVersion()
  const ok = reaPresent() && got === ver
  return { ok, got, err: ok ? "" : lastLine(r.err) }
}

// One full cycle: look up npm's latest, install it when newer (or when rea is broken).
// Result codes: up-to-date | updated | deferred | locked | check-failed | install-failed | skipped
export async function checkAndUpdate({ who, log = NOOP, force = false, minAgeMs = 0, npmTimeout = 15_000 } = {}) {
  const st0 = readState()
  const cur0 = installedVersion()
  if (!force && st0.lastCheck && Date.now() - st0.lastCheck < minAgeMs) {
    return { result: "skipped", installed: cur0, latest: st0.latest || "", msg: st0.lastMsg || "" }
  }
  const finish = (result, msg, extra = {}) => {
    const installed = installedVersion()
    const latest = extra.latest || st0.latest || ""
    const pending = !!latest && (!reaPresent() || newer(latest, installed))
    writeState({ lastCheck: extra.keepCheck ? st0.lastCheck : Date.now(), lastCheckBy: who, installed, latest, pending, lastResult: result, lastMsg: msg, lastResultAt: Date.now(), ...(["up-to-date", "updated"].includes(result) ? { lastSuccess: Date.now() } : {}) })
    log(`${result}: ${msg}`)
    return { result, msg, installed, latest, pending }
  }
  const v = await npm(["view", "rea-agents", "version", "--prefer-online"], npmTimeout)
  const latest = v.out.trim()
  if (v.code !== 0 || !/^\d+\.\d+\.\d+$/.test(latest)) return finish("check-failed", `无法查询 npm（离线或超时），保持 ${cur0 || "当前"} 版本: ${lastLine(v.err)}`)
  const broken = !reaPresent() || !cur0
  if (!broken && !newer(latest, cur0)) return finish("up-to-date", `已是最新 ${cur0}`, { latest })
  const lock = acquireLock(who)
  if (!lock.ok) return finish("locked", `另一个更新进程正在安装（${lock.reason}），本次跳过`, { latest })
  try {
    const q = await runningRea()
    if (!q.ok) return finish("deferred", `无法确认是否有 rea 在运行（${q.err}），暂缓更新到 ${latest}`, { latest })
    if (q.procs.length) return finish("deferred", `有 ${q.procs.length} 个 rea 进程在运行（PID ${q.procs.map((p) => p.pid).join(",")}），暂缓更新到 ${latest}，稍后重试`, { latest })
    log(`installing rea-agents@${latest} (was ${cur0 || "missing"})`)
    const r = await install(latest, log)
    if (r.ok) return finish("updated", `已更新 ${cur0 || "（缺失）"} → ${r.got}`, { latest })
    return finish("install-failed", `安装 ${latest} 失败，当前 ${r.got || "无"}${reaPresent() ? "" : "（rea.mjs 缺失）"}: ${r.err}`, { latest })
  } finally { releaseLock(lock) }
}

// launcher helper: rea.mjs is missing (cut-off install) -> wait for / run the repair, up to waitMs
export async function heal({ who, log = NOOP, waitMs = 180_000 }) {
  const end = Date.now() + waitMs
  while (!reaPresent() && Date.now() < end) {
    const r = await checkAndUpdate({ who, log, force: true })
    if (reaPresent() || r.result !== "locked") break
    await new Promise((z) => setTimeout(z, 3000))
  }
  return reaPresent()
}
