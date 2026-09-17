--[[
  CE Lua: find instruction RIPs that write to a data address.

  Loaded and invoked by src/handlers/monitor_writes.ts via MCP ce_eval_lua.
  Edit this file to change breakpoint behavior, hit shaping, or JSON fields.

  Contract (return value of monitorWrites):
    JSON string matching WriteDumpSchema:
      {
        "watched_address": "0x...",
        "writes": [ { "rip": "0x...", "location": "...", "count": N }, ... ]
      }

  Flow:
    ensure debugging → one bptWrite hardware watch → sleep(durationMs)
    → remove breakpoint → return deduped RIP hits with module+offset names
]]

local function jsonEscape(s)
  s = tostring(s)
  s = s:gsub("\\", "\\\\")
  s = s:gsub("\"", "\\\"")
  s = s:gsub("\n", "\\n")
  s = s:gsub("\r", "\\r")
  s = s:gsub("\t", "\\t")
  return s
end

local function hexAddress(n)
  return string.format("0x%016X", n)
end

--- Watch writes to `address` for `durationMs`, then return WriteDump JSON.
--- @param address number data address to watch
--- @param size number watch size in bytes (typically 4 for int32)
--- @param durationMs number how long to collect hits before removing the breakpoint
function monitorWrites(address, size, durationMs)
  address = tonumber(address)
  size = tonumber(size) or 4
  durationMs = tonumber(durationMs) or 3000

  if address == nil then
    error("monitorWrites: address must be a number")
  end

  if not debug_isDebugging() then
    debugProcess()
  end

  local hits = {}

  -- Prefer a per-breakpoint callback so we do not rely on a global
  -- debugger_onBreakpoint dispatcher (hardware slot limit: one active watch).
  debug_setBreakpoint(address, size, bptWrite, bpmDebugRegister, function()
    local rip = RIP
    if hits[rip] == nil then
      hits[rip] = 0
    end
    hits[rip] = hits[rip] + 1
    debug_continueFromBreakpoint(co_run)
    return 1
  end)

  sleep(durationMs)

  debug_removeBreakpoint(address)

  local writes = {}
  for rip, count in pairs(hits) do
    local location = getNameFromAddress(rip)
    if location == nil or location == "" then
      location = hexAddress(rip)
    end
    writes[#writes + 1] = {
      rip = hexAddress(rip),
      location = location,
      count = count,
    }
  end

  table.sort(writes, function(a, b)
    if a.count ~= b.count then
      return a.count > b.count
    end
    return a.rip < b.rip
  end)

  local parts = {}
  for i = 1, #writes do
    local w = writes[i]
    parts[#parts + 1] = string.format(
      '{"rip":"%s","location":"%s","count":%d}',
      w.rip,
      jsonEscape(w.location),
      w.count
    )
  end

  return string.format(
    '{"watched_address":"%s","writes":[%s]}',
    hexAddress(address),
    table.concat(parts, ",")
  )
end
