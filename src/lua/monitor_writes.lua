--[[
  CE Lua: find instruction RIPs that write to a data address.

  Loaded and invoked by src/handlers/monitor_writes.ts via MCP ce_eval_lua.
  Edit this file to change breakpoint behavior, hit shaping, or JSON fields.

  Contract (return value of monitorWrites):
    JSON string matching WriteDumpSchema:
      {
        "watched_address": "0x...",
        "type": "int32",
        "size": 4,
        "writes": [ { "rip": "0x...", "ripRaw": "...", "location": "...", "count": N }, ... ]
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

local SIZE_FROM_TYPE = {
  byte = 1, int8 = 1, uint8 = 1,
  int16 = 2,
  int32 = 4, int = 4, float = 4,
  int64 = 8, double = 8,
  string = 4, wstring = 4,
}

local TYPE_FROM_SIZE = {
  [1] = "byte",
  [2] = "int16",
  [4] = "int32",
  [8] = "int64",
}

--- Watch writes to `address` for `durationMs`, then return WriteDump JSON.
--- @param address number data address to watch
--- @param size number watch size in bytes (typically 4 for int32)
--- @param durationMs number how long to collect hits before removing the breakpoint
--- @param vtype string|nil re-mcp scan type (int32, float, ...); inferred from size if omitted
function monitorWrites(address, size, durationMs, vtype)
  address = tonumber(address)
  durationMs = tonumber(durationMs) or 3000

  if type(vtype) == "string" and vtype ~= "" then
    size = tonumber(size) or SIZE_FROM_TYPE[vtype] or 4
  else
    size = tonumber(size) or 4
    vtype = TYPE_FROM_SIZE[size] or "int32"
  end

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
    local entry = hits[rip]
    if entry == nil then
      entry = { count = 0, raw = tostring(RIP) }
      hits[rip] = entry
    end
    entry.count = entry.count + 1
    debug_continueFromBreakpoint(co_run)
    return 1
  end)

  sleep(durationMs)

  debug_removeBreakpoint(address)

  local writes = {}
  for rip, entry in pairs(hits) do
    local location = getNameFromAddress(rip)
    if location == nil or location == "" then
      location = hexAddress(rip)
    end
    writes[#writes + 1] = {
      rip = hexAddress(rip),
      ripRaw = entry.raw,
      location = location,
      count = entry.count,
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
      '{"rip":"%s","ripRaw":"%s","location":"%s","count":%d}',
      w.rip,
      jsonEscape(w.ripRaw),
      jsonEscape(w.location),
      w.count
    )
  end

  return string.format(
    '{"watched_address":"%s","type":"%s","size":%d,"writes":[%s]}',
    hexAddress(address),
    jsonEscape(vtype),
    size,
    table.concat(parts, ",")
  )
end
