--[[
  CE Lua: remove a write watchpoint / breakpoint by address.

  Invoked by src/handlers/write_breakpoint.ts via MCP ce_eval_lua.
  addressSpec may be hex ("0x..."), decimal, or CE notation ("game.exe+1234").
]]

function removeWriteBreakpoint(addressSpec)
  local address = getAddress(tostring(addressSpec))
  if address == nil or address == 0 then
    address = tonumber(addressSpec)
  end
  if address == nil then
    error("removeWriteBreakpoint: cannot resolve " .. tostring(addressSpec))
  end

  debug_removeBreakpoint(address)
  return true
end
