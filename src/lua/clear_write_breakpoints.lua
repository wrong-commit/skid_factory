--[[
  CE Lua: remove every active debugger breakpoint and force-continue the target.
]]

function clearAllWriteBreakpoints()
  local list = debug_getBreakpointList()
  local removed = 0
  if list ~= nil then
    for _, address in ipairs(list) do
      if pcall(function() debug_removeBreakpoint(address) end) then
        removed = removed + 1
      end
    end
  end
  -- If the target is sitting on a hit, kick it so the game unfreezes.
  pcall(function() debug_continueFromBreakpoint(co_run) end)
  return removed
end
