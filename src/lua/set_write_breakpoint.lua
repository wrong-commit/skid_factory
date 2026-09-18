--[[
  CE Lua: set a single hardware write breakpoint (bptWrite).

  Prefer timed monitorWrites() — persistent write BPs on hot addresses still
  stutter even when continue is correct.

  Continue policy: debug_continueFromBreakpoint(co_run) + return 1
]]

local function resolveAddress(addressSpec)
  local s = tostring(addressSpec)
  local address = getAddressSafe and getAddressSafe(s) or getAddress(s)
  if (address == nil or address == 0) and not s:match('^%s*"') then
    local mod, op, off = s:match("^%s*(.-)%s*([+-])%s*(0?[xX]?%x+)%s*$")
    if mod and op and off and mod:find("%s") then
      mod = mod:gsub('^"+', ""):gsub('"+$', "")
      local quoted = string.format('"%s"%s%s', mod, op, off)
      address = getAddressSafe and getAddressSafe(quoted) or getAddress(quoted)
    end
  end
  if address == nil or address == 0 then
    address = tonumber(s)
  end
  return address
end

function setWriteBreakpoint(addressSpec, size)
  size = tonumber(size) or 4

  local address = resolveAddress(addressSpec)
  if address == nil then
    error("setWriteBreakpoint: cannot resolve " .. tostring(addressSpec))
  end

  if not debug_isDebugging() then
    debugProcess()
  end

  local function onHit()
    debug_continueFromBreakpoint(co_run)
    return 1
  end

  debugger_onBreakpoint = onHit
  debug_setBreakpoint(address, size, bptWrite, bpmDebugRegister, onHit)
  return string.format("0x%016X", address)
end
