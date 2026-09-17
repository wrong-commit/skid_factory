--[[
  CE Lua: set a single hardware write breakpoint (bptWrite).

  Prefer timed monitorWrites() — persistent write BPs on hot addresses still
  stutter even when continue is correct.

  Continue policy: debug_continueFromBreakpoint(co_run) + return 1
]]

function setWriteBreakpoint(addressSpec, size)
  size = tonumber(size) or 4

  local address = getAddress(tostring(addressSpec))
  if address == nil or address == 0 then
    address = tonumber(addressSpec)
  end
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
