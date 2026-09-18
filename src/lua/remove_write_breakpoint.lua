--[[
  CE Lua: remove a write watchpoint / breakpoint by address.

  Invoked by src/handlers/write_breakpoint.ts via MCP ce_eval_lua.
  addressSpec may be hex ("0x..."), decimal, or CE notation
  ("game.exe+1234" / "NOT A HERO.exe"+1FF50D).
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

function removeWriteBreakpoint(addressSpec)
  local address = resolveAddress(addressSpec)
  if address == nil then
    error("removeWriteBreakpoint: cannot resolve " .. tostring(addressSpec))
  end

  debug_removeBreakpoint(address)
  return true
end
