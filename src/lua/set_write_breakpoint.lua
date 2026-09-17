--[[
  CE Lua: set a single hardware write breakpoint (bptWrite).

  Invoked by src/handlers/write_breakpoint.ts via MCP ce_eval_lua.
  One active watch intended — call removeWriteBreakpoint on the previous address first.
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

  debug_setBreakpoint(address, size, bptWrite, bpmDebugRegister)
  return string.format("0x%016X", address)
end
