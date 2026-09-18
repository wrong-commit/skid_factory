--[[
  CE Lua: find instruction RIPs that write to a data address.

  Loaded by src/handlers/monitor_writes.ts via MCP ce_eval_lua.

  Continue policy (CE canonical — see Lua Debugging wiki / issue #911):
    debug_continueFromBreakpoint(co_run)
    return 1   -- we handled it; do NOT update debugger UI
  return 0 means "break into the UI" and freezes the game for the user.

  On each unique RIP's first hit we also snapshot all GPRs + a few fixed
  derefs (see snapshotRegs / snapshotDerefs). Opcode-driven deref inference
  is intentionally out of scope — see TODO below.
]]

--[[
  TODO — SPEC: opcode-driven register/deref inference (future)

  Goal: on write-BP hit, parse the faulting instruction's operands and only
  dump the registers / memory expressions that the store actually uses
  (e.g. `movsd [eax+0x100], xmm0` → eax, [eax+0x100], xmm0).

  Sketch:
    1. Prefer CE `disassemble(RIP)` / `splitDisassembledString` (or get the
       previous instruction when RIP is post-store).
    2. Parse ModR/M / displacement from the opcode bytes (not the text) for
       base, index, scale, disp — fall back to text parse only if needed.
    3. Emit `used_regs: string[]` and `derefs: { expr: hexValue }` limited to
       those operands; keep full `regs` optional behind a flag.
    4. Handle 32/64-bit and common SSE/AVX stores (movsd/movss/movdqu).

  Non-goals for that work: full symbolic execution, stack unwinding.
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

-- All CE debugger register globals we care about (32 + 64 bit).
local REG_NAMES = {
  "EAX", "EBX", "ECX", "EDX", "ESI", "EDI", "EBP", "ESP", "EIP",
  "RAX", "RBX", "RCX", "RDX", "RSI", "RDI", "RBP", "RSP", "RIP",
  "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15",
  "EFLAGS", "RFLAGS",
}

local function snapshotRegs()
  local regs = {}
  for i = 1, #REG_NAMES do
    local name = REG_NAMES[i]
    local v = _G[name]
    if type(v) == "number" then
      regs[name] = hexAddress(v)
    end
  end
  return regs
end

local function readU32(addr)
  if addr == nil or type(addr) ~= "number" then return nil end
  local ok, v = pcall(function()
    if type(readInteger) == "function" then
      return readInteger(addr)
    end
    return nil
  end)
  if ok and type(v) == "number" then
    return hexAddress(v)
  end
  return nil
end

-- Fixed deref set for pointer-chain tracing (no opcode parsing).
-- Prefer 32-bit names; fall back to 64-bit equivalents when EAX/ECX absent.
local function snapshotDerefs()
  local eax = EAX
  if type(eax) ~= "number" then eax = RAX end
  local ecx = ECX
  if type(ecx) ~= "number" then ecx = RCX end

  local derefs = {}
  if type(ecx) == "number" then
    local v0 = readU32(ecx)
    if v0 ~= nil then derefs["[ecx]"] = v0 end
    local v4 = readU32(ecx + 4)
    if v4 ~= nil then derefs["[ecx+4]"] = v4 end
  end
  if type(eax) == "number" then
    local v100 = readU32(eax + 0x100)
    if v100 ~= nil then derefs["[eax+0x100]"] = v100 end
  end
  return derefs
end

local function jsonObject(map)
  local keys = {}
  for k in pairs(map) do
    keys[#keys + 1] = k
  end
  table.sort(keys)
  local parts = {}
  for i = 1, #keys do
    local k = keys[i]
    local v = map[k]
    if v == nil then
      parts[#parts + 1] = string.format('"%s":null', jsonEscape(k))
    else
      parts[#parts + 1] = string.format('"%s":"%s"', jsonEscape(k), jsonEscape(v))
    end
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

-- ±ctx around RIP (matches REPL `disassemble` default). Done after the watch
-- window so we do not disassemble under the BP callback.
local DISASM_CTX = 5

local function prevInstruction(a)
  if type(getPreviousOpcode) ~= "function" then return nil end
  local prev = getPreviousOpcode(a)
  if prev == nil or prev == 0 or prev >= a then return nil end
  return prev
end

local function disassembleAround(rip, before, after)
  before = before or DISASM_CTX
  after = after or DISASM_CTX
  if type(disassemble) ~= "function" then return {} end

  local start = rip
  for _ = 1, before do
    local prev = prevInstruction(start)
    if not prev then break end
    start = prev
  end

  local out = {}
  local cur = start
  local total = before + 1 + after
  for _ = 1, total do
    local ok, d = pcall(disassemble, cur)
    if not ok or d == nil then break end

    local addr_s, op_s, bytes_s, extra_s
    if type(splitDisassembledString) == "function" then
      addr_s, op_s, bytes_s, extra_s = splitDisassembledString(d)
    end
    local numeric = string.format("%X", cur)
    local resolved = addr_s
    if resolved == nil or resolved == "" then
      resolved = (extra_s ~= nil and extra_s ~= "" and extra_s) or numeric
    end

    out[#out + 1] = {
      address = tostring(resolved or ""),
      bytes = tostring(bytes_s or ""),
      opcode = tostring(op_s or ""),
      comment = tostring(extra_s or ""),
      raw = tostring(d),
      target = (cur == rip),
    }

    local size = 1
    if type(getInstructionSize) == "function" then
      local sok, sz = pcall(getInstructionSize, cur)
      if sok and type(sz) == "number" and sz > 0 then size = sz end
    end
    cur = cur + size
  end
  return out
end

local function jsonDisasm(instructions)
  local parts = {}
  for i = 1, #instructions do
    local ins = instructions[i]
    local targetJson = ins.target and "true" or "false"
    parts[#parts + 1] = string.format(
      '{"address":"%s","bytes":"%s","opcode":"%s","comment":"%s","raw":"%s","target":%s}',
      jsonEscape(ins.address),
      jsonEscape(ins.bytes),
      jsonEscape(ins.opcode),
      jsonEscape(ins.comment),
      jsonEscape(ins.raw),
      targetJson
    )
  end
  return "[" .. table.concat(parts, ",") .. "]"
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
        hits[rip] = {
          count = 1,
          regs = snapshotRegs(),
          derefs = snapshotDerefs(),
        }
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
    local disasmOk, disasm = pcall(disassembleAround, rip, DISASM_CTX, DISASM_CTX)
    writes[#writes + 1] = {
      rip = hexAddress(rip),
      ripRaw = tostring(rip),
      location = location,
      count = entry.count,
      regs = entry.regs or {},
      derefs = entry.derefs or {},
      disasm = (disasmOk and disasm) or {},
    }
  end

  if unknownCount > 0 then
    writes[#writes + 1] = {
      rip = "0x0000000000000000",
      ripRaw = "unknown",
      location = "unknown",
      count = unknownCount,
      regs = {},
      derefs = {},
      disasm = {},
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
      '{"rip":"%s","ripRaw":"%s","location":"%s","count":%d,"regs":%s,"derefs":%s,"disasm":%s}',
      w.rip,
      jsonEscape(w.ripRaw),
      jsonEscape(w.location),
      w.count,
      jsonObject(w.regs),
      jsonObject(w.derefs),
      jsonDisasm(w.disasm)
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
