// This script will start the Not a Hero game (if not already running) and start
// the point tracer POC TS script. This will open a Node JS REPL that allows
// for providing console input to 1. cancel 2. enter new value (int32) and search
// 3. choose from search results and view related assembler and select for "monitor" breakpoint
// 4. consistently dump monitored breakpoint stats 5. choose from breakpoints to begin monitoring now
// 6. provide dump of monitored breakpoint stats to user for review 7. repeat until user has found base address and add to "base_addresses.json"

/** Parse argv to get p */
function parsePid(argv: string[]): number {
    const arg = argv.find((a) => a.startsWith("--pid="));
    if (!arg) {
        throw new Error('Missing required argument "--pid=XXX"');
    }
    const value = arg.slice("--pid=".length);
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Invalid --pid value: ${value}`);
    }
    return pid;
}

const main = async (pid: number) => {
    /* Connect to MCP server and validate OK
    Begin CE search with ce_scan_first using console input value as starting value
        Filter in loop calling ce_scan_next until "choose_address" is entered
        If "choose_address" is entered, print and return address
    Add a write breakpoint to this address in CE
    Print out details
    Wait until console input "show_write_locations"
        Print out the assembly for each location in response JSON from CE
    ```json
    {
    "watched_address": "0x000001F812345678",
    "writes": [
        {
        "rip": "0x00007FF612341234",
        "location": "game.exe+0x1234",
        "count": 1832
        },
        {
        "rip": "0x00007FF612348765",
        "location": "game.exe+0x8765",
        "count": 421
        }
    ]
    }
    ```
    Prove iteration works by entering "follow_address game.exe+0x8765" which replaces
    the breakpoint with one for this address. Repeat until the user enters either 
    "base_address game.exe+0x1234" or "base_address 0x00007FF612348765"
    Store the base_address in a "poc_base_address.json" file for POC purposes.
    */
}

// FIXME: make this file can be imported without executing main()
main(parsePid(process.argv.slice(2)))
