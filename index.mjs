// magpie-rea-updater: server side, runs in Magpie's plugin host (Bun).
// Keeps the global npm package rea-agents current for all agents:
//  - checks npm on a timer (default every 6h) and when the Magpie window asks for it (panel, throttled to 10 min)
//  - installs a newer version by itself, through the shared lock / running-rea guard in ./rea-update-lib.mjs
//    (the same logic the DeepSeek Harness launcher rea-mcp-launch.mjs uses)
//  - the Page/panel talk to this host through plugin options (options.request in, options.status out), like
//    magpie-agent-purge-updater; the host restarts on every options change.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkAndUpdate, readState, installedVersion, run } from "./rea-update-lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(HERE, "updater.log")
const PKG = path.join(HERE, "package.json")
const DOT = "🟠 " // title prefix while an update is pending or failed (Magpie has no badge API for plugin tabs)
const INTERVALS = [1, 6, 12, 24]
const AUTO_MIN_AGE = 10 * 60_000 // window-open checks never hit npm more often than this

function log(msg) {
  try {
    try { if (fs.statSync(LOG).size > 100_000) fs.writeFileSync(LOG, "") } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}
function tailLog(n) {
  try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).slice(-n).map((l) => l.replace(/^\d{4}-(\d\d-\d\dT\d\d:\d\d:\d\d)\.\d+Z/, "$1Z")) } catch { return [] }
}
function syncBadge(on) {
  try {
    const raw = fs.readFileSync(PKG, "utf8")
    const pkg = JSON.parse(raw)
    const fix = (o) => {
      if (!o || typeof o !== "object") return
      const f = (v) => (typeof v === "string" ? (on ? DOT : "") + v.replace(/^🟠\s*/u, "") : v)
      if (o.title) o.title = f(o.title)
      if (o.titles && typeof o.titles === "object") for (const k of Object.keys(o.titles)) o.titles[k] = f(o.titles[k])
    }
    const m = pkg.magpie || {}
    fix(m.page)
    for (const p of m.panels || []) fix(p)
    const next = JSON.stringify(pkg, null, 2) + "\n"
    if (next === raw) return
    const tmp = PKG + ".tmp"
    fs.writeFileSync(tmp, next, "utf8")
    fs.renameSync(tmp, PKG)
    log(`badge ${on ? "on" : "off"}`)
  } catch (e) { log("badge sync failed: " + (e && e.message || e)) }
}

function cfg(opts) {
  const n = Number(opts && opts.intervalHours)
  return { intervalHours: INTERVALS.includes(n) ? n : 6 }
}

function buildStatus() {
  const s = readState()
  return {
    checkedAt: s.lastCheck ? new Date(s.lastCheck).toISOString() : null,
    installed: installedVersion() || s.installed || "",
    latest: s.latest || "",
    pending: !!s.pending,
    result: s.lastResult || "",
    msg: s.lastMsg || "",
    by: s.lastCheckBy || "",
    log: tailLog(12),
  }
}
// what the Page shows besides the log: when this is unchanged an options write (= host restart) is not needed
const core = (s) => JSON.stringify({ ...s, log: undefined })

let magpieCmd
function findMagpie() {
  if (magpieCmd) return magpieCmd
  for (const d of (process.env.PATH || "").split(path.delimiter)) for (const n of ["magpie.exe", "magpie.com", "magpie.cmd"]) {
    const p = path.join(d, n)
    if (d && fs.existsSync(p)) return (magpieCmd = p)
  }
  return (magpieCmd = "magpie")
}
async function writeOptions(opts) {
  const r = await run(findMagpie(), ["plugin", "options", HERE, JSON.stringify(opts)], { timeout: 30_000 })
  log(`options write exit=${r.code}${r.code === 0 ? "" : " " + (r.err || r.out).trim().slice(0, 200)}`)
  return r.code === 0
}

export default {
  id: "magpie-rea-updater",
  server: async (_input, options) => {
    const g = globalThis
    const c = cfg(options)
    const opts = options && typeof options === "object" ? { ...options } : {}
    if (g.__reaUpdTimer) clearTimeout(g.__reaUpdTimer)
    log(`host init: interval=${c.intervalHours}h`)
    const s0 = readState()
    syncBadge(!!s0.pending)
    let chain = Promise.resolve()
    const serial = (fn) => (chain = chain.then(fn, fn))

    async function cycle(opt) {
      let res
      try { res = await checkAndUpdate({ who: "magpie", log, ...opt }) } catch (e) { log("cycle error: " + (e && e.message || e)); res = { result: "error" } }
      const st = buildStatus()
      syncBadge(st.pending || st.result === "install-failed")
      return { res, st }
    }

    async function timerCheck(fromPendingRetry = false) {
      const { res, st } = await cycle({ minAgeMs: 60_000 })
      log(`timer check: ${res.result} installed=${st.installed} latest=${st.latest}`)
      // a failed pending retry must not write options: that write restarts the host, the host would see
      // pending again and retry every ~90 s. One retry per host start, then wait for the normal interval.
      if (fromPendingRetry && !["up-to-date", "updated"].includes(res.result)) { schedule(false); return }
      const cur = opts.status || {}
      if (core({ ...st, handledId: cur.handledId }) !== core(cur)) { if (!(await writeOptions({ ...opts, status: { ...st, handledId: cur.handledId } }))) schedule(false) }
      else schedule(false)
    }

    function schedule(initial) {
      const every = c.intervalHours * 3600_000
      const due = (readState().lastCheck || 0) + every - Date.now()
      const delay = Math.min(Math.max(due, initial ? 15_000 : 60_000), 2 ** 31 - 1)
      g.__reaUpdTimer = setTimeout(() => serial(timerCheck), delay)
      log(`next auto check in ${Math.round(delay / 60000)} min`)
    }

    // A pending update (newer on npm, or last install failed/deferred): retry right after each host
    // start. No need to wait for old rea processes to exit — the runningRea() check at install time
    // defers safely if any are still alive. The 5 s is only to let host init settle past the
    // 1 s request handling and avoid fighting it.
    function schedulePendingRetry() {
      clearTimeout(g.__reaUpdTimer)
      g.__reaUpdTimer = setTimeout(() => serial(() => timerCheck(true)), 5_000)
      log("update pending after host start: retry in 5 s")
    }

    async function handleRequest(req) {
      // a terminal `magpie` command loads plugins too: only one process may run a given request
      const lock = path.join(HERE, `request-${String(req.id).replace(/\W/g, "")}.lock`)
      try {
        for (const f of fs.readdirSync(HERE)) if (/^request-.*\.lock$/.test(f)) { const p = path.join(HERE, f); try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60_000) fs.unlinkSync(p) } catch {} }
        fs.writeFileSync(lock, String(req.id), { flag: "wx" })
      } catch { log(`request ${req.id} already taken by another process`); return }
      log(`request ${req.id} ${req.action}`)
      const manual = req.action === "check"
      const { res, st } = await cycle(manual ? { force: true } : { minAgeMs: AUTO_MIN_AGE })
      log(`${manual ? "manual" : "window-open"} check: ${res.result} installed=${st.installed} latest=${st.latest}`)
      // this write restarts the plugin host
      if (!(await writeOptions({ ...opts, status: { ...st, handledId: req.id } }))) schedule(false)
    }

    const req = opts.request
    const pending = req && req.id && req.id !== (opts.status || {}).handledId && Date.now() - Number(req.at || 0) < 10 * 60_000
    if (pending && ["check", "auto"].includes(req.action)) g.__reaUpdTimer = setTimeout(() => serial(() => handleRequest(req)), 1000)
    else if (!pending && (s0.pending || readState().pending)) schedulePendingRetry()
    else schedule(true)
    return {}
  },
}
