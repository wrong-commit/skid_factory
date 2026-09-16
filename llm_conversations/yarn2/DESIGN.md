# Autonomous game hacking agent 

One specific goal: provide the basic tools an agent will require for game hacking

    searching memory for multiple data types (int, float, double, etc), use reductive search pattern
    editing memory addresses 
    resolving pointer base address
    traverse pointer of pointer to find base address
    inspect screenshot for checking current health value / user supplied input 
    control character/replay keypresses to trigger health going down 
    restart game and launch single player 
    allow manual intervention with global keybinds to hint (value reduced/value increased/specific value) at search type 
    inject DLL (provided injector) skill 
    rebuild DLL Skill 



Loop:

    Launch game
    Let player start game (key bind to continue) 
    Search starting value (key bind) 
    Let player reduce value
    Search again, repeat until player dead or cancelled manually 
    Once few enough addresses found (let user choose) begin pointer resolution 
    Resolve expected pointer base address, use LLM to inspect registers and ASM
    Once base address found, store as possible pointer in JSON db file 
    Repeat for all available addresses 
    Then for each address in JSON db for future processing 
    Phase 1: every tick overwrite base address with static value
    Phase 2: overwrite ASM with noop to prevent writing to address in first place 
    Modify DLL to implement phase 1/2 patching of memory addresses 
    Build DLL
    inject DLL 
    Let user: start game, trigger cheat, confirm if fix worked or not, or describe issue
    Let LLM plan next steps ? 
    Try with the next address in JSON and rebuild inject verification loop 
    If confirmed, hack created. Let user restart and retest if desired 


Possible issues:

    having LLM parse ASM and registers to identify base address may not work
    Difficult to set up gameplay loop automatically, so provide hotkeys so the hacker can iterate quickly 
    Need to provide pop up that lets operator iterate and supply custom search values, UI development means choosing GUI library 
    Needs a cool name and a quick demo 
    Parsing stack traces for errors automatically, may need custom tooling 
    Workflow of steps, needing to jump between them to test ? May be a simple loop with escape hatches is enough 
    Having to use windows, maybe Linux or Mac would be easier for quicker development 
    Implementing address space search, tricky as requires deeper memory layout knowledge than I possess 
    Anti cheat detecting injected DLLSs 
    LLM parseable knowledge space for 
    1. Value in address to pointer path data model, including relevant ASM write/read path codes 
    2. Address search space 
    3. Desired hacks 
    Better to have cli tools and sub agents that spin up separate searches and return structured input. How do LLMs perform with checking off tasks? Well in my experience yes with MD checklists 
    LLM not being able to address inspecting screen for weird fonts, needs a manual “did not work” escape hatch and manual input of new values 


Features:

    Above todo loop list of skills 
    Inspect MD to evaluate current state of every investigated hack/address value and performed steps 
    Key bindings for quicker searching
    Pop up for providing custom search value 
    Autonomous resolving of pointer and base address 
    Patching multiple addresses per hack, to patch multiple writers 


Future features: 

    reconstructing player/enemy data model structs
    Autonomously navigating menu and game world 
    More data types other than required POC int
    Embedding view of window within other terminal based view of debugging information 


Limitations:

    Manual interventions required 
    Only int to start with for memory searches 




———-

# thoughts 


Mcp-cheat-engine on GitHub provides access to cheat engine native calls, as well as assembly debugger and ghidra reverse engineering capabilities. Could allow for patching the binary manually


Use this instead of building skills manually. This allows for user to manually interact with cheat engine for improved control. 

    add ability to debug currently selected pointer chain location as window with decompiled c code from ghidra 
    Add ability to step through and debug manually ??? From game with hotkeys and transparent gui showing ASM and registers? 


Use node JS for orchestration instead of python. Better backwards compat, re-mcp integration, shared code base, I hate python for systems programming, typescript types.


Use electron for rendering transparent windows in front of the foreground window 


Keeps code in JS or in mcp controlled program. Allow for manually debugging with tool windows 


Should probably build a demo program for faster iteration. However this means building in memory randomisation and such for address list filtering testing. Probably better but slower to use real game for searching 


Thankfully searching requires restarting the prober and not the game state 