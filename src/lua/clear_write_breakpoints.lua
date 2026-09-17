--[[
  CE Lua: remove every active debugger breakpoint.

  Invoked by src/handlers/write_breakpoint.ts via MCP ce_eval_lua on POC exit.
  This POC only places bptWrite watches, so clearing the full breakpoint list
  clears all write watches we created (plus any other BPs currently in CE).

  Returns the number of addresses removed.
]]

function clearAllWriteBreakpoints()
  local list = debug_getBreakpointList()
  if list == nil then
    return 0
  end

  local removed = 0
  for _, address in ipairs(list) do
    debug_removeBreakpoint(address)
    removed = removed + 1
  end

  return removed
end
