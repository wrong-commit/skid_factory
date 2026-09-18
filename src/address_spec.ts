/**
 * Cheat Engine address specs: hex, decimal, and module+offset
 * (including module names with spaces, quoted or unquoted).
 */

const MODULE_EXT = String.raw`exe|dll|bin|so|dylib|elf`;

/** True when `spec` is module+offset / symbol-like rather than a raw integer. */
export function isSymbolicAddressSpec(spec: string): boolean {
    const s = spec.trim();
    if (!s) return false;
    if (/^0x[0-9A-Fa-f]+$/i.test(s)) return false;
    if (/^\d+$/.test(s)) return false;
    if (/^[0-9A-Fa-f]+$/i.test(s) && (/[A-Fa-f]/.test(s) || s.length >= 8)) return false;
    return true;
}

/**
 * Normalize a CE address spec for Lua getAddress / breakpoints.
 * Bare hex like `0C505970` → `0x...`; quote module names that contain spaces:
 * `NOT A HERO.exe+1FF50D` → `"NOT A HERO.exe"+1FF50D`.
 */
export function normalizeAddressSpec(spec: string): string {
    const s = spec.trim();
    if (!s) return s;

    const quoted = /^"([^"]+)"\s*([+\-])\s*((?:0x)?[0-9A-Fa-f]+)$/i.exec(s);
    if (quoted) {
        return `"${quoted[1]}"${quoted[2]}${quoted[3]}`;
    }

    const quotedModOnly = /^"([^"]+)"$/.exec(s);
    if (quotedModOnly) {
        return `"${quotedModOnly[1]}"`;
    }

    const modOff = /^(.+?)\s*([+\-])\s*((?:0x)?[0-9A-Fa-f]+)$/i.exec(s);
    if (modOff && /[A-Za-z_]/.test(modOff[1]!)) {
        const mod = modOff[1]!.trim().replace(/^"+|"+$/g, "");
        const op = modOff[2]!;
        const off = modOff[3]!;
        if (/\s/.test(mod)) {
            return `"${mod}"${op}${off}`;
        }
        return `${mod}${op}${off}`;
    }

    if (/^0x[0-9A-Fa-f]+$/i.test(s)) {
        return s;
    }
    if (/^[0-9A-Fa-f]+$/i.test(s) && (/[A-Fa-f]/.test(s) || s.length >= 8)) {
        return `0x${s}`;
    }
    return s;
}

/**
 * Pull a CE address off the front of a command tail.
 * Handles `NOT A HERO.exe+1FF50D ctx=5` without splitting on spaces in the module name.
 */
export function parseLeadingAddressSpec(
    input: string,
): { address: string; rest: string } | null {
    const s = input.trim();
    if (!s) return null;

    const quoted = /^"[^"]+"\s*(?:[+\-]\s*(?:0x)?[0-9A-Fa-f]+)?/i.exec(s);
    if (quoted) {
        return {
            address: normalizeAddressSpec(quoted[0]!.replace(/\s+([+\-])\s+/, "$1")),
            rest: s.slice(quoted[0]!.length).trim(),
        };
    }

    const firstTok = /^(\S+)/.exec(s)?.[1];
    if (firstTok) {
        if (
            /^0x[0-9A-Fa-f]+$/i.test(firstTok) ||
            /^\d+$/.test(firstTok) ||
            (/^[0-9A-Fa-f]+$/i.test(firstTok) &&
                (/[A-Fa-f]/.test(firstTok) || firstTok.length >= 8))
        ) {
            return {
                address: normalizeAddressSpec(firstTok),
                rest: s.slice(firstTok.length).trim(),
            };
        }
        // Single-token module+offset (no spaces in module name)
        if (/^.+[+\-](?:0x)?[0-9A-Fa-f]+$/i.test(firstTok) && /[A-Za-z_]/.test(firstTok)) {
            return {
                address: normalizeAddressSpec(firstTok),
                rest: s.slice(firstTok.length).trim(),
            };
        }
    }

    const withExt = new RegExp(
        `^(.+?\\.(?:${MODULE_EXT}))\\s*([+\\-])\\s*((?:0x)?[0-9A-Fa-f]+)(?=\\s|$)`,
        "i",
    ).exec(s);
    if (withExt) {
        return {
            address: normalizeAddressSpec(`${withExt[1]}${withExt[2]}${withExt[3]}`),
            rest: s.slice(withExt[0]!.length).trim(),
        };
    }

    const generic = /^(.+?)\s*([+\-])\s*((?:0x)?[0-9A-Fa-f]+)(?=\s|$)/.exec(s);
    if (generic && /[A-Za-z]/.test(generic[1]!)) {
        return {
            address: normalizeAddressSpec(`${generic[1]}${generic[2]}${generic[3]}`),
            rest: s.slice(generic[0]!.length).trim(),
        };
    }

    return null;
}

/** Parse optional `5` or `ctx=5` (NaN if malformed). */
export function parseCtxArg(token: string | undefined, defaultCtx = 5): number {
    if (token === undefined || token === "") return defaultCtx;
    const m = /^(?:ctx=)?(\d+)$/i.exec(token.trim());
    if (!m) return Number.NaN;
    return Number(m[1]);
}

export function parseDisassembleArgs(
    rest: string,
): { address: string; ctx: number } | { error: string } {
    const usage = "Usage: disassemble <loc|hex|module+off> [ctx=5]";
    const parsed = parseLeadingAddressSpec(rest);
    if (!parsed) return { error: usage };
    const tokens = parsed.rest === "" ? [] : parsed.rest.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) return { error: usage };
    const ctx = parseCtxArg(tokens[0], 5);
    if (!Number.isInteger(ctx) || ctx < 0 || ctx > 100) {
        return { error: "Usage: disassemble <loc|hex|module+off> [ctx=0..100]" };
    }
    return { address: parsed.address, ctx };
}
