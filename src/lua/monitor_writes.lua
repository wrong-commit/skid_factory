--[[
  CE Lua: find instruction RIPs that write to a data address.

  Loaded by src/handlers/monitor_writes.ts via MCP ce_eval_lua.

  Continue policy (CE canonical — see Lua Debugging wiki / issue #911):
    debug_continueFromBreakpoint(co_run)
    return 1   -- we handled it; do NOT update debugger UI
  return 0 means "break into the UI" and freezes the game for the user.
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

local function currentIP()
  if RIP ~= nil then return RIP end
  if EIP ~= nil then return EIP end
  if type(getInstructionPointer) == "function" then
    local ok, ip = pcall(getInstructionPointer)
    if ok and type(ip) == "number" and ip ~= 0 then return ip end
  end
  return nil
end

local function forceContinue()
  pcall(function() debug_continueFromBreakpoint(co_run) end)
end

local function clearAllBreakpoints()
  local existing = debug_getBreakpointList()
  if existing == nil then return 0 end
  local n = 0
  for _, bp in ipairs(existing) do
    if pcall(function() debug_removeBreakpoint(bp) end) then
      n = n + 1
    end
  end
  forceContinue()
  return n
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

  clearAllBreakpoints()

  if not debug_isDebugging() then
    debugProcess()
  end

  local hits = {}
  local unknownCount = 0
  local previousHandler = debugger_onBreakpoint

  local function onHit()
    local ok, err = pcall(function()
      local rip = currentIP()
      if rip == nil then
        unknownCount = unknownCount + 1
        return
      end
      local entry = hits[rip]
      if entry == nil then
        hits[rip] = { count = 1 }
      else
        entry.count = entry.count + 1
      end
    end)
    if not ok then
      print("[monitorWrites] breakpoint callback: " .. tostring(err))
    end
    debug_continueFromBreakpoint(co_run)
    return 1
  end

  -- Install both global + per-BP callback (CE builds differ on which fires).
  debugger_onBreakpoint = onHit
  debug_setBreakpoint(address, size, bptWrite, bpmDebugRegister, onHit)

  -- Keep CE's main thread pumping so continues are processed.
  local stopAt = getTickCount() + durationMs
  while getTickCount() < stopAt do
    if type(checkSynchronize) == "function" then
      pcall(checkSynchronize)
    end
    sleep(10)
  end

  pcall(function() debug_removeBreakpoint(address) end)
  clearAllBreakpoints()
  debugger_onBreakpoint = previousHandler
  forceContinue()

  local writes = {}
  for rip, entry in pairs(hits) do
    local location = getNameFromAddress(rip)
    if location == nil or location == "" then
      location = hexAddress(rip)
    end
    writes[#writes + 1] = {
      rip = hexAddress(rip),
      ripRaw = tostring(rip),
      location = location,
      count = entry.count,
    }
  end

  if unknownCount > 0 then
    writes[#writes + 1] = {
      rip = "0x0000000000000000",
      ripRaw = "unknown",
      location = "unknown",
      count = unknownCount,
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
